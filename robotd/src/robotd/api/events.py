"""WebSocket 事件订阅会话（契约 ``/v1/events``）。

对齐语义（契约原文与接口契约 §6 要求）：

```
连接 → hello{instance_id} → 客户端 subscribe{types, resume_from_seq, instance_id}
     → subscription.accepted{subscription_id, filters}
     → state.snapshot（含 event_seq 游标）
     → 按序补发 seq > 游标 的匹配事件 → 之后实时推送
```

关键点：

- **快照与订阅同锁**：``kernel.subscribe()`` 在返回时已经在同一把锁内取好快照与积压，
  所以没有「取快照与开始监听之间的窗口」。本模块只负责把这两段按顺序写出去。
- **游标过期 / 实例变更 → ``resync_required``**：宁可让客户端重拉状态，也不给一段有洞的流。
- **经过滤的订阅看不到某些全局 seq 不代表丢包**：本模块不据此发 gap 告警，只在
  ``resume`` 判定为过期时明确告知。
- **背压**：每条连接一个有界队列 + 独立写线程。队列满 → 断开这条订阅（客户端重连并重拉快照），
  绝不让慢客户端阻塞内核的归并路径。
"""

from __future__ import annotations

import json
import logging
import queue
import socket
import threading
from typing import Any

from ..app import App
from ..core.kernel import Handle
from ..core.types import Event
from .ws import WebSocket, WsProtocolError

log = logging.getLogger("robotd.api.events")

#: 每条连接允许积压的事件上限。超出即判定慢客户端并断开（客户端会重连 + 重拉快照）。
QUEUE_MAX = 512
#: 单条消息发送超时；超时即断开，不无限等待。
SEND_TIMEOUT_S = 5.0

ALLOWED_FILTERS_HINT = "* / task.* / speech.* …"


def _parse_types(raw: str | None) -> list[str]:
    if not raw:
        return ["*"]
    parts = [t.strip() for t in raw.split(",") if t.strip()]
    return parts or ["*"]


def _parse_int(raw: str | None, *, name: str) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise WsProtocolError(f"{name} 必须是整数") from exc
    if value < 0:
        raise WsProtocolError(f"{name} 不得为负")
    return value


def serve_ws(app: App, sock: socket.socket, handshake: Any, query: dict[str, list[str]]) -> None:
    """处理一条已升级的 WS 连接，直到对端关闭或出错。

    ``query`` 是**已解析**的 query 字典（``parse_qs`` 结果），不是原始字符串——
    早期版本在这里二次解析导致 AttributeError，会话一建立就崩。
    """
    ws = WebSocket(sock)
    outbox: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=QUEUE_MAX)
    writer_done = threading.Event()
    handle_box: list[Handle] = []

    def writer() -> None:
        try:
            while True:
                item = outbox.get()
                if item is None:
                    break
                ws.send_text(json.dumps(item, ensure_ascii=False), timeout_s=SEND_TIMEOUT_S)
        except WsProtocolError as exc:
            log.info("WS 写线程结束：%s", exc)
        finally:
            writer_done.set()

    def enqueue(msg: dict[str, Any]) -> None:
        try:
            outbox.put_nowait(msg)
        except queue.Full:
            log.warning("订阅积压超过 %s，断开慢客户端", QUEUE_MAX)

            # 队列满：标记结束并关闭 socket，让读循环退出
            try:
                outbox.put_nowait(None)
            except queue.Full:
                pass
            ws.close(1013, "backpressure: client too slow")
            raise

    def push_event(ev: Event) -> None:
        try:
            enqueue({"type": "event", "event": ev.to_public()})
        except Exception:  # noqa: BLE001 - 内核据此摘除订阅，符合设计
            raise

    t_writer = threading.Thread(target=writer, name="ws-writer", daemon=True)
    t_writer.start()

    try:
        instance_id = app.instance_id
        enqueue(
            {
                "type": "hello",
                "contract_version": app.info.contract_version,
                "instance_id": instance_id,
                "server": app.info.name,
                "server_version": app.info.version,
                "event_log_max": app.config.event_log_max,
                "filter_hint": ALLOWED_FILTERS_HINT,
            }
        )

        # 客户端必须先 subscribe；也允许在 URL 里给初始 types 直接订阅（便于调试脚本）
        initial_types = _parse_types((query.get("types") or [None])[0])
        resume_from = _parse_int((query.get("resume_from_seq") or [None])[0], name="resume_from_seq")
        client_instance = (query.get("instance_id") or [None])[0]
        auto_subscribed = bool(query.get("types") or resume_from is not None)

        def do_subscribe(types: list[str], resume_seq: int | None, client_inst: str | None) -> None:
            verdict, backlog = "ok", []
            if resume_seq is not None:
                verdict, backlog = app.kernel.resume(client_inst, resume_seq)
            if verdict != "ok":
                enqueue(
                    {
                        "type": "resync_required",
                        "reason": verdict,
                        "instance_id": instance_id,
                        "last_seq": app.kernel.last_seq,
                        "detail": {
                            "instance_changed": "robotd 进程实例已变更，客户端必须重拉 /v1/robot/state",
                            "cursor_expired": "游标早于保留窗口，补发不可用，必须重拉状态",
                            "invalid_cursor": "游标不合法（为负或超前于当前 seq）",
                        }.get(verdict, verdict),
                    }
                )
                # resync 后仍然建立订阅，只是从头对齐：客户端重拉快照后继续收增量
                backlog = []

            # 顺序纪律：`subscription.accepted` 与 `state.snapshot` 必须先于任何实时事件。
            # 竞态来源：kernel.subscribe() 注册后，别处的 emit() 可能在另一个线程里
            # 立刻调用 push_event，抢在我们 enqueue 这两条之前。做法是：
            # 先用缓冲接住实时事件 → 写 accepted/snapshot/backlog → 再切直通并回放缓冲。
            buffered: list[Event] = []
            passthrough = False
            buffer_lock = threading.Lock()

            def gated_push(ev: Event) -> None:
                with buffer_lock:
                    if not passthrough:
                        buffered.append(ev)
                        return
                push_event(ev)

            handle = app.kernel.subscribe(types, gated_push)
            handle_box.append(handle)
            enqueue(
                {
                    "type": "subscription.accepted",
                    "subscription_id": f"sub-{handle.sub_id}",
                    "filters": types,
                    "resume": {
                        "requested_from_seq": resume_seq,
                        "verdict": verdict,
                        "replayed": len(backlog),
                    },
                }
            )
            enqueue({"type": "state.snapshot", "state": handle.snapshot})
            for ev in backlog:
                enqueue({"type": "event", "event": ev.to_public()})
            with buffer_lock:
                passthrough = True
                held, buffered = list(buffered), []
            for ev in held:
                enqueue({"type": "event", "event": ev.to_public()})

        if auto_subscribed:
            do_subscribe(initial_types, resume_from, client_instance)

        while not writer_done.is_set():
            raw = ws.recv_message()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                enqueue({"type": "error", "error": {"code": "E_VALIDATION", "message": "消息不是合法 JSON"}})
                continue
            if not isinstance(msg, dict):
                enqueue({"type": "error", "error": {"code": "E_VALIDATION", "message": "消息必须是对象"}})
                continue
            kind = msg.get("type")
            if kind == "subscribe":
                if handle_box:
                    enqueue(
                        {
                            "type": "error",
                            "error": {
                                "code": "E_STATE",
                                "message": "本连接已订阅；如需更换过滤条件请重连",
                            },
                        }
                    )
                    continue
                # 字段名以契约为准：`WsClientMessage.subscribe` 要求 `event_types`
                # （contracts/openapi.yaml 第 988/993 行）。早期实现读的是 `types`，
                # 与契约不一致，导致按契约写的客户端订阅过滤失效、退化成「订阅全部」。
                # 这里以 `event_types` 为准，同时接受 `types` 作为兼容别名（旧面板/脚本仍在用）。
                types = msg.get("event_types")
                if types is None:
                    types = msg.get("types")
                if types is None:
                    # 契约里 `event_types` 是必填；缺省不当作「订阅全部」，明确报错，
                    # 免得调用方以为过滤生效了。
                    enqueue(
                        {
                            "type": "error",
                            "error": {"code": "E_VALIDATION", "message": "subscribe 需要 event_types 数组"},
                        }
                    )
                    continue
                if isinstance(types, list) and all(isinstance(t, str) for t in types):
                    # 空数组合法（契约：表示暂不订阅，仅取快照），此时不该退化成 ["*"]
                    filters = [t for t in types if t] or []
                else:
                    enqueue(
                        {
                            "type": "error",
                            "error": {"code": "E_VALIDATION", "message": "types 必须是字符串数组"},
                        }
                    )
                    continue
                rseq = msg.get("resume_from_seq")
                if rseq is not None and (not isinstance(rseq, int) or isinstance(rseq, bool) or rseq < 0):
                    enqueue(
                        {
                            "type": "error",
                            "error": {
                                "code": "E_VALIDATION",
                                "message": "resume_from_seq 必须是非负整数",
                            },
                        }
                    )
                    continue
                do_subscribe(filters, rseq, msg.get("instance_id"))
            elif kind == "ping":
                enqueue({"type": "pong", "ts": msg.get("ts")})
            elif kind == "unsubscribe":
                for h in handle_box:
                    h.close()
                handle_box.clear()
                enqueue({"type": "unsubscribed"})
            else:
                enqueue(
                    {
                        "type": "error",
                        "error": {"code": "E_VALIDATION", "message": f"未知消息类型 {kind!r}"},
                    }
                )
    except WsProtocolError as exc:
        log.info("WS 协议错误：%s", exc)
    except Exception:  # noqa: BLE001
        log.exception("WS 会话未分类异常")
    finally:
        for h in handle_box:
            h.close()
        try:
            outbox.put_nowait(None)
        except queue.Full:
            pass
        ws.close(1000, "")
        t_writer.join(timeout=2.0)


def parse_types_query(raw: str | None) -> list[str]:
    return _parse_types(raw)


__all__ = ["serve_ws", "parse_types_query", "QUEUE_MAX"]

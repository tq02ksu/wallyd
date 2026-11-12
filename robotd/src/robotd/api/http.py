"""HTTP 传输层：把内核与能力表投影成 ``contracts/openapi.yaml`` 的 v1 公开面。

设计要点（对应 plan R09）：

1. **公开面由契约决定，不由能力表决定**。路由表手写但逐条对应 operationId；
   能力表只决定「这条路由此刻可用还是 503/E_UNAVAILABLE」，不新增路由。
   ``tests/contract/`` 里有一条测试比对路由 ↔ ``contracts/openapi.yaml`` 的 operationId 集合，
   少一条或多一条都会失败——防止「代码悄悄多了个后门」。
2. **统一错误体**：一切异常都经 ``RobotdError.to_public()``；未分类异常归 500/E_INTERNAL，
   不把内部故障伪装成 400（旧 POC 的缺陷）。
3. **只绑回环**：配置层已强制；这里再加一层 Host 校验，拒绝非回环 Host 头（防 DNS rebinding）。
4. **请求体有上限**：超限直接 413，不无限读。
5. **debug 端点只在 ``--debug`` 下注册**，且不进 MCP 工具面（生成器按 tag 过滤）。

线程模型：每条连接一个线程（标准库 ``ThreadingHTTPServer``）。robotd 的控制隔离机制尚未定案
（R02），本层**不假装**提供了时序保证，只保证「HTTP 调用 → 内核 emit → 订阅者收到」这条链路
的所有状态写入仍走内核那一把锁。
"""

from __future__ import annotations

import json
import logging
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
from xml.sax.saxutils import escape as _xml_escape  # noqa: F401 - 保留给将来的 HTML 错误页

from ..approval import CREDENTIAL_HEADER, enforce_approval
from ..app import App, resolve_work_dir
from ..core.announce import (
    APPROVAL_UNHEARD,
    APPROVAL_REPEAT,
    CLARIFICATION,
    CLARIFICATION_REASONS,
    render_announcement,
    render_clarification,
)
from ..core.errors import ErrorCode, RobotdError, wrap_unexpected
from ..core.safety import StopCause, is_valid_cause
from ..core.types import Exclusivity, TaskError, TaskState
from . import events as events_api
from .ws import WsProtocolError, parse_handshake

log = logging.getLogger("robotd.api.http")

MAX_BODY_BYTES = 64 * 1024
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


# ===================================================================== 路由
Handler = Callable[["RouteContext"], Any]


class RouteContext:
    """一次请求的上下文。处理函数只拿到它需要的三样东西，不接触原始 socket。"""

    __slots__ = ("app", "method", "path", "query", "params", "body", "handler")

    def __init__(
        self,
        *,
        app: App,
        method: str,
        path: str,
        query: dict[str, list[str]],
        params: dict[str, str],
        body: dict[str, Any],
        handler: "BaseHTTPRequestHandler",
    ) -> None:
        self.app = app
        self.method = method
        self.path = path
        self.query = query
        self.params = params
        self.body = body
        self.handler = handler


class Route:
    __slots__ = ("method", "template", "pattern", "fn", "operation_id", "requires_approval")

    def __init__(
        self,
        method: str,
        template: str,
        fn: Handler,
        *,
        operation_id: str,
        requires_approval: bool = False,
    ) -> None:
        self.method = method
        self.template = template
        self.fn = fn
        self.operation_id = operation_id
        self.requires_approval = requires_approval
        self.pattern = _compile_template(template)

    def match(self, method: str, path: str) -> dict[str, str] | None:
        if method != self.method:
            return None
        return self.pattern(path)


def _compile_template(template: str) -> Callable[[str], dict[str, str] | None]:
    """把 ``/v1/tasks/{task_id}`` 编成匹配函数。手写而非正则，避免转义陷阱。"""
    parts = [p for p in template.strip("/").split("/")]

    def matcher(path: str) -> dict[str, str] | None:
        got = [p for p in path.strip("/").split("/")]
        if len(got) != len(parts):
            return None
        out: dict[str, str] = {}
        for want, have in zip(parts, got):
            if want.startswith("{") and want.endswith("}"):
                if not have:
                    return None
                out[want[1:-1]] = have
            elif want != have:
                return None
        return out

    return matcher


# ===================================================================== 校验工具
def _require_str(body: dict[str, Any], key: str, *, max_len: int = 200) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 必须是非空字符串")
    if len(value) > max_len:
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 超过 {max_len} 字符上限")
    return value.strip()


def _optional_number(body: dict[str, Any], key: str, *, minimum: float | None = None) -> float | None:
    if key not in body or body[key] is None:
        return None
    value = body[key]
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 必须是数字")
    if minimum is not None and float(value) < minimum:
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 不得小于 {minimum}")
    return float(value)


def _optional_str(body: dict[str, Any], key: str, *, max_len: int = 200) -> str | None:
    if key not in body or body[key] is None:
        return None
    value = body[key]
    if not isinstance(value, str) or not value.strip():
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 必须是非空字符串")
    if len(value) > max_len:
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 超过 {max_len} 字符上限")
    return value.strip()


def _optional_str_list(
    body: dict[str, Any],
    key: str,
    *,
    max_len: int,
    max_items: int,
    pattern: re.Pattern[str] | None = None,
) -> list[str]:
    if key not in body or body[key] is None:
        return []
    value = body[key]
    if not isinstance(value, list):
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 必须是字符串数组")
    if len(value) > max_items:
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 最多 {max_items} 项")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 的每一项都必须是非空字符串")
        text = item.strip()
        if len(text) > max_len:
            raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 的项超过 {max_len} 字符上限")
        if pattern is not None and not pattern.match(text):
            raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 的项含非法字符：{text!r}")
        out.append(text)
    return out


def _reject_unknown(body: dict[str, Any], allowed: set[str]) -> None:
    """未声明字段直接拒绝。

    这条是``capabilities.py`` 的同一纪律在传输层的延伸：宁可让调用方改代码，
    也不接受「看起来没报错所以生效了」的静默忽略。
    """
    extra = set(body) - allowed
    if extra:
        raise RobotdError(
            ErrorCode.VALIDATION,
            f"未声明的字段：{', '.join(sorted(extra))}",
            {"allowed": sorted(allowed)},
        )


# ===================================================================== 能力门
def _call_capability(app: App, name: str, fn: Callable[[Any], Any]) -> Any:
    """经能力表检查后执行。未实现 → 503/E_UNAVAILABLE 并带原因。"""
    cap = app.registry.get(name)
    cap.check_available()
    return fn(cap)


def _enforce_approval(ctx: RouteContext, route: Route) -> None:
    """审批门：``Route.requires_approval`` 唯一的读取点。

    能力名与「必须绑定的参数」都来自能力表（它已由契约一致性测试锁住）；
    秘密与已消费 nonce 的路径分别由 :mod:`robotd.approval` 解析。
    **``--debug`` 不改变这条判断**：调试旁路只多开 ``/v1/debug/*``。
    """
    cap = ctx.app.registry.by_public_name(route.operation_id)
    enforce_approval(
        header_value=_credential_header(ctx.handler),
        capability=route.operation_id,
        approval_params=cap.approval_params,
        body=ctx.body,
        work_dir=resolve_work_dir(ctx.app.config),
    )


def _credential_header(handler: BaseHTTPRequestHandler | None) -> str | None:
    if handler is None:
        return None
    return handler.headers.get(CREDENTIAL_HEADER)


# ===================================================================== 处理函数
def _h_health(ctx: RouteContext) -> dict[str, Any]:
    return ctx.app.health()


def _h_state(ctx: RouteContext) -> dict[str, Any]:
    return ctx.app.snapshot()


def _h_stop(ctx: RouteContext) -> dict[str, Any]:
    # 停止不需要审批，也不等模型：这是安全旁路（契约 /v1/robot/stop）
    body = ctx.body
    _reject_unknown(body, {"reason", "cause", "detail"})
    detail = body.get("detail")
    if detail is not None and not isinstance(detail, str):
        raise RobotdError(ErrorCode.VALIDATION, "字段 detail 必须是字符串")
    cause = body.get("cause")
    if cause is not None:
        if not is_valid_cause(cause):
            raise RobotdError(
                ErrorCode.VALIDATION,
                f"未知停止原因：{cause!r}",
                {"allowed": sorted(c.value for c in StopCause)},
            )
        result = _call_capability(
            ctx.app,
            "robot.stop",
            lambda _cap: ctx.app.request_stop(cause=StopCause(str(cause)), detail=detail),
        )
        return _stop_result_or_timeout(result)

    reason = body.get("reason") if isinstance(body.get("reason"), str) else "stop"
    if reason not in {"stop", "user", "api", "shutdown"}:
        reason = "stop"
    result = _call_capability(
        ctx.app,
        "robot.stop",
        lambda _cap: ctx.app.request_stop(reason=reason, detail=detail),
    )
    return _stop_result_or_timeout(result)


def _stop_result_or_timeout(result: dict[str, Any]) -> dict[str, Any]:
    if result.get("board_ack") is False:
        # 契约：未收到板侧应答报 504，不返回 200（调用方不得据此认为机器人仍在动）
        raise RobotdError(
            ErrorCode.TIMEOUT,
            "已请求停止，但未在时限内收到板侧应答",
            {"stopped": True, "stopped_tasks": result.get("stopped_tasks", 0)},
        )
    return result


def _h_task_get(ctx: RouteContext) -> dict[str, Any]:
    task_id = ctx.params["task_id"]
    return _call_capability(ctx.app, "task.get", lambda _cap: ctx.app.kernel.get_task(task_id).to_public())


def _h_task_cancel(ctx: RouteContext) -> dict[str, Any]:
    task_id = ctx.params["task_id"]

    def cancel(_cap: Any) -> dict[str, Any]:
        task = ctx.app.kernel.get_task(task_id)
        if task.terminal:
            return task.to_public()
        if task.exclusivity is Exclusivity.MOTION:
            # 运动任务取消必须联动 stop：只改任务表会让电机继续跑
            ctx.app.request_stop(reason="task_cancel")
        ctx.app.clear_pause_timer(task_id)
        return ctx.app.kernel.finish(task_id, TaskState.CANCELLED, reason="requested").to_public()

    return _call_capability(ctx.app, "task.cancel", cancel)


def _h_task_pause(ctx: RouteContext) -> dict[str, Any]:
    """``task_pause``：速度归零、位置保持、任务不终结（GH-48）。

    不要求审批：暂停只降低风险；``resume`` 也不需要重签，因为没有改变任何
    被用户确认并绑定过的参数。审批门仍由 ``robot_follow`` 等动作端点承担。
    """
    task_id = ctx.params["task_id"]
    _reject_unknown(ctx.body, set())
    return _call_capability(ctx.app, "task.pause", lambda _cap: ctx.app.pause_task(task_id))


def _h_task_resume(ctx: RouteContext) -> dict[str, Any]:
    """``task_resume``：从 paused 回到 running；不新建任务、不重发动作能力。"""
    task_id = ctx.params["task_id"]
    _reject_unknown(ctx.body, set())
    return _call_capability(ctx.app, "task.resume", lambda _cap: ctx.app.resume_task(task_id))


def _h_tasks_list(ctx: RouteContext) -> dict[str, Any]:
    state_q = (ctx.query.get("state") or [""])[0]
    tasks = [t.to_public() for t in ctx.app.kernel.list_tasks()]
    if state_q:
        tasks = [t for t in tasks if t["state"] == state_q]
    return {"tasks": tasks}


def _optional_bool(body: dict[str, Any], key: str) -> bool | None:
    if key not in body or body[key] is None:
        return None
    value = body[key]
    if not isinstance(value, bool):
        raise RobotdError(ErrorCode.VALIDATION, f"字段 {key} 必须是布尔值")
    return value


def _h_speak(ctx: RouteContext) -> dict[str, Any]:
    """``robot_speak``。契约：``{text, voice, rate, interruptible}`` → ``TaskAccepted``。

    分句播报 + 有界队列 + 打断由桥负责；这里只做受理、任务登记与句数上报。
    """
    body = ctx.body
    _reject_unknown(body, {"text", "voice", "rate", "interruptible"})
    text = _require_str(body, "text", max_len=500)  # 契约 maxLength: 500
    voice = body.get("voice")
    if voice is not None and not isinstance(voice, str):
        raise RobotdError(ErrorCode.VALIDATION, "字段 voice 必须是字符串")
    rate = _optional_number(body, "rate", minimum=0.1)
    if rate is not None and rate > 1:
        raise RobotdError(ErrorCode.VALIDATION, "字段 rate 不得超过 1")
    interruptible = _optional_bool(body, "interruptible")
    interruptible = True if interruptible is None else interruptible

    def run(_cap: Any) -> dict[str, Any]:
        runtime = ctx.app.audio
        task = ctx.app.kernel.new_task("robot.speak", Exclusivity.SOFT)
        try:
            ctx.app.kernel.mark_running(task.task_id)
            resp = runtime.new_response(task_id=task.task_id)
            runtime.speak(resp, text=text, voice=voice, rate=rate, interruptible=interruptible)
        except Exception as exc:  # noqa: BLE001
            ctx.app.kernel.finish(
                task.task_id,
                TaskState.FAILED,
                error=TaskError("E_UNAVAILABLE", str(exc)),
                reason="audio_unavailable",
            )
            raise RobotdError(
                ErrorCode.UNAVAILABLE,
                f"无法播报：{exc}",
                {"capability": "robot.speak"},
            ) from exc
        return {"task_id": task.task_id, "status": "accepted"}

    return _call_capability(ctx.app, "robot.speak", run)


_APPROVAL_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")
_ANNOUNCE_SLOT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ANNOUNCE_FIELDS = {
    "approval_id",
    "kind",
    "action_label",
    "args_summary",
    "reason",
    "missing",
    "candidates",
    "more",
}


def _h_announce(ctx: RouteContext) -> dict[str, Any]:
    """``robot_announce``：系统播报路径（审批复述 / 澄清追问），**不走审批门**。

    与 ``robot_speak`` 的边界是契约级的：这里没有 ``text`` 参数，只有结构化的审批字段，
    正文由 robotd 用固定模板渲染。播报完成以 ``speech.tts_finished``（带 ``kind``，
    审批复述另带 ``approval_id``）为准；
    失败会发 ``speech.announce_failed``，不能静默。
    """
    body = ctx.body
    _reject_unknown(body, _ANNOUNCE_FIELDS)
    kind = _require_str(body, "kind", max_len=40)
    approval_id: str | None = None
    if kind in (APPROVAL_REPEAT, APPROVAL_UNHEARD):
        # 审批复述专属字段：混入澄清字段说明调用方搞错了形状，不能猜。
        extra = {"reason", "missing", "candidates", "more"} & set(body)
        if extra:
            raise RobotdError(
                ErrorCode.VALIDATION,
                f"approval_repeat 不接受字段：{', '.join(sorted(extra))}",
            )
        approval_id = _require_str(body, "approval_id", max_len=64)
        if not _APPROVAL_ID.match(approval_id):
            raise RobotdError(ErrorCode.VALIDATION, "approval_id 含非法字符")
        action_label = _require_str(body, "action_label", max_len=80)
        args_summary = _require_str(body, "args_summary", max_len=60)
        try:
            text = render_announcement(kind=kind, action_label=action_label, args_summary=args_summary)
        except ValueError as exc:
            raise RobotdError(ErrorCode.VALIDATION, str(exc)) from exc
    elif kind == CLARIFICATION:
        # 澄清没有审批记录：approval_id / args_summary 是审批复述的字段。
        extra = {"approval_id", "args_summary"} & set(body)
        if extra:
            raise RobotdError(
                ErrorCode.VALIDATION,
                f"clarification 不接受字段：{', '.join(sorted(extra))}",
            )
        reason = _require_str(body, "reason", max_len=40)
        if reason not in CLARIFICATION_REASONS:
            raise RobotdError(
                ErrorCode.VALIDATION,
                f"不支持的澄清原因 reason={reason!r}；只允许 {sorted(CLARIFICATION_REASONS)}",
            )
        action_label = _optional_str(body, "action_label", max_len=80)
        missing = _optional_str_list(body, "missing", max_len=64, max_items=8, pattern=_ANNOUNCE_SLOT)
        candidates = _optional_str_list(body, "candidates", max_len=80, max_items=3)
        more = bool(_optional_bool(body, "more"))
        try:
            text = render_clarification(
                reason=reason,
                action_label=action_label,
                missing=missing,
                candidates=candidates,
                more=more,
            )
        except ValueError as exc:
            raise RobotdError(ErrorCode.VALIDATION, str(exc)) from exc
    else:
        raise RobotdError(ErrorCode.VALIDATION, f"不支持的播报类型 kind={kind!r}")

    def run(_cap: Any) -> dict[str, Any]:
        runtime = ctx.app.audio
        # new_task 的 BUSY 直接向上抛（同类播报已在跑），不伪装成桥故障
        task = ctx.app.kernel.new_task("robot.announce", Exclusivity.SOFT)
        resp = None
        try:
            ctx.app.kernel.mark_running(task.task_id)
            resp = runtime.new_response(task_id=task.task_id, approval_id=approval_id, kind=kind)
            runtime.speak(resp, text=text, interruptible=True)
        except Exception as exc:  # noqa: BLE001
            if resp is not None:
                # 受理后发送失败：清掉运行时引用，避免 audio.state 永远显示 speaking
                runtime.clear_response(resp)
                # 已经发出去的句子要在桥侧停住；否则 agentd 判定失败后机器人还在念。
                runtime.cancel_speaking("announce_failed")
            ctx.app.kernel.finish(
                task.task_id,
                TaskState.FAILED,
                error=TaskError("E_UNAVAILABLE", str(exc)),
                reason="audio_unavailable",
            )
            # 失败也必须可观测：agentd 不能因为「请求发出去了」就以为问过用户
            try:
                failed: dict[str, Any] = {
                    "kind": kind,
                    "task_id": task.task_id,
                    "reason": str(exc),
                }
                if approval_id is not None:
                    failed["approval_id"] = approval_id
                ctx.app.kernel.emit("speech.announce_failed", failed)
            except Exception:  # noqa: BLE001
                log.warning("发送 speech.announce_failed 失败", exc_info=True)
            raise RobotdError(
                ErrorCode.UNAVAILABLE,
                f"无法进行系统播报：{exc}",
                {"capability": "robot.announce", **({"approval_id": approval_id} if approval_id else {})},
            ) from exc
        accepted: dict[str, Any] = {
            "task_id": task.task_id,
            "status": "accepted",
            "kind": kind,
            "text": text,
        }
        if approval_id is not None:
            accepted["approval_id"] = approval_id
        return accepted

    return _call_capability(ctx.app, "robot.announce", run)


def _h_follow(ctx: RouteContext) -> dict[str, Any]:
    body = ctx.body
    _reject_unknown(body, {"target", "target_track_id", "max_distance_m", "note"})
    track = body.get("target_track_id")
    target = body.get("target")
    if not track and not target:
        raise RobotdError(
            ErrorCode.VALIDATION,
            "必须提供 target_track_id（已绑定目标）或 target（语义描述）",
        )
    max_d = _optional_number(body, "max_distance_m", minimum=0.2)
    if max_d is not None and max_d > 10:
        raise RobotdError(ErrorCode.VALIDATION, "max_distance_m 不得超过 10 米")

    def run(_cap: Any) -> dict[str, Any]:
        task = ctx.app.kernel.new_task("robot.follow", Exclusivity.MOTION)
        ctx.app.kernel.mark_running(task.task_id)
        return ctx.app.kernel.get_task(task.task_id).to_public()

    return _call_capability(ctx.app, "robot.follow", run)


def _h_listen(ctx: RouteContext) -> dict[str, Any]:
    """``speech_listen``。契约：``{max_seconds, locale, auto_endpoint}`` → ``TaskAccepted``。

    **受理不等于听到了**：``accepted`` 只说明这一轮已经交给桥；识别结果与是否
    「压根没人说话」都经 ``speech.*`` 事件给出（``final.no_speech``）。
    """
    body = ctx.body
    _reject_unknown(body, {"max_seconds", "locale", "auto_endpoint"})
    max_seconds = _optional_number(body, "max_seconds", minimum=5)
    if max_seconds is not None and max_seconds > 1800:
        raise RobotdError(ErrorCode.VALIDATION, "字段 max_seconds 不得超过 1800")
    max_seconds = 300.0 if max_seconds is None else max_seconds
    locale = body.get("locale", "zh_CN")
    if not isinstance(locale, str) or not locale.strip():
        raise RobotdError(ErrorCode.VALIDATION, "字段 locale 必须是非空字符串")
    auto_endpoint = _optional_bool(body, "auto_endpoint")
    auto_endpoint = True if auto_endpoint is None else auto_endpoint

    def run(_cap: Any) -> dict[str, Any]:
        runtime = ctx.app.audio
        # 静音期间拒绝开始新的识别（R14）。返回**状态冲突**而不是「依赖不可用」：
        # 静音是用户自己的选择，不是故障，UI 不该把它显示成错误。
        if runtime.muted:
            raise RobotdError(
                ErrorCode.STATE,
                "当前处于静音状态，不会开始新的识别；先调用 POST /v1/audio/unmute",
                {"capability": "speech.listen", "muted": True},
            )
        task = ctx.app.kernel.new_task("speech.listen", Exclusivity.SOFT)
        try:
            ctx.app.kernel.mark_running(task.task_id)
            runtime.new_utterance(
                task_id=task.task_id,
                locale=locale.strip(),
                auto_endpoint=auto_endpoint,
                max_seconds=max_seconds,
            )
        except Exception as exc:  # noqa: BLE001
            ctx.app.kernel.finish(
                task.task_id,
                TaskState.FAILED,
                error=TaskError("E_UNAVAILABLE", str(exc)),
                reason="audio_unavailable",
            )
            raise RobotdError(
                ErrorCode.UNAVAILABLE,
                f"无法开始听音：{exc}",
                {"capability": "speech.listen"},
            ) from exc
        return {"task_id": task.task_id, "status": "accepted"}

    return _call_capability(ctx.app, "speech.listen", run)


def _h_audio_state(ctx: RouteContext) -> dict[str, Any]:
    return _call_capability(ctx.app, "audio.state", lambda _cap: ctx.app.audio_state())


def _h_speech_abort(ctx: RouteContext) -> dict[str, Any]:
    """``speech_abort``。契约：``{response_id?}`` → ``TaskAccepted``。

    **这是「停止播报」，不是「取消任务」**：barge-in 是正常结束，不能标失败。
    无活动播报时也返回 200（幂等）——语音场景下用户可能连说两次「停」。
    真正的中止事实以 ``speech.tts_cancelled{reason:"user_cancel", played, dropped}`` 为准。
    """
    body = ctx.body
    _reject_unknown(body, {"response_id"})
    response_id = body.get("response_id")
    if response_id is not None:
        if not isinstance(response_id, str) or not response_id.strip():
            raise RobotdError(ErrorCode.VALIDATION, "字段 response_id 必须是非空字符串")
        response_id = response_id.strip()
        if len(response_id) > 64:
            raise RobotdError(ErrorCode.VALIDATION, "字段 response_id 超过 64 字符上限")

    def run(_cap: Any) -> dict[str, Any]:
        task = ctx.app.kernel.new_task("speech.abort", Exclusivity.SOFT)
        ctx.app.kernel.mark_running(task.task_id)
        aborted = ctx.app.audio.abort_speaking(response_id=response_id, reason="user_cancel")
        ctx.app.kernel.finish(
            task.task_id,
            TaskState.COMPLETED,
            reason="aborted" if aborted else "no_active_playback",
        )
        return {"task_id": task.task_id, "status": "accepted"}

    return _call_capability(ctx.app, "speech.abort", run)


def _h_audio_mute(ctx: RouteContext) -> dict[str, Any]:
    return _call_capability(ctx.app, "audio.mute", lambda _cap: ctx.app.set_audio_muted(True))


def _h_audio_unmute(ctx: RouteContext) -> dict[str, Any]:
    return _call_capability(ctx.app, "audio.unmute", lambda _cap: ctx.app.set_audio_muted(False))


def _h_calib_get(ctx: RouteContext) -> dict[str, Any]:
    return _call_capability(ctx.app, "robot.calibration.get", lambda _cap: ctx.app.read_calibration())


def _h_calib_set(ctx: RouteContext) -> dict[str, Any]:
    body = ctx.body
    _reject_unknown(body, {"left_steps_per_m", "right_steps_per_m", "wheel_base_m", "note"})
    changes = {k: v for k, v in body.items() if k != "note"}
    if not changes:
        raise RobotdError(ErrorCode.VALIDATION, "至少提供一个标定字段")

    def run(_cap: Any) -> dict[str, Any]:
        return ctx.app.write_calibration(changes)

    return _call_capability(ctx.app, "robot.calibration.set", run)


def _h_debug_serial(ctx: RouteContext) -> dict[str, Any]:
    body = ctx.body
    _reject_unknown(body, {"op", "args", "timeout_ms"})
    op = _require_str(body, "op", max_len=64)
    return ctx.app.debug_board_request(op, body.get("args") or {}, int(body.get("timeout_ms") or 500))


def _h_debug_state(ctx: RouteContext) -> dict[str, Any]:
    return {
        "state": ctx.app.snapshot(),
        "kernel": ctx.app.kernel.stats(),
        "caps": [c.to_public() for c in ctx.app.registry.all()],
    }


def _h_debug_tasks(ctx: RouteContext) -> dict[str, Any]:
    return {"tasks": [t.to_public() for t in ctx.app.kernel.list_tasks()]}


def _h_debug_events(ctx: RouteContext) -> dict[str, Any]:
    return {"events": [e.to_public() for e in ctx.app.kernel.recent_events(100)]}


# ===================================================================== 路由表
def build_routes(*, debug: bool) -> list[Route]:
    """公开路由表。**必须与 contracts/openapi.yaml 的 operationId 一一对应**。"""
    routes = [
        Route("GET", "/v1/health", _h_health, operation_id="robot_health"),
        Route("GET", "/v1/robot/state", _h_state, operation_id="robot_state"),
        Route("POST", "/v1/robot/stop", _h_stop, operation_id="robot_stop"),
        Route("GET", "/v1/tasks", _h_tasks_list, operation_id="task_list"),
        Route("GET", "/v1/tasks/{task_id}", _h_task_get, operation_id="task_get"),
        Route("DELETE", "/v1/tasks/{task_id}", _h_task_cancel, operation_id="task_cancel"),
        # GH-48：暂停/恢复挂在任务资源下；都不需要审批（没有改变已确认参数）。
        Route("POST", "/v1/tasks/{task_id}/pause", _h_task_pause, operation_id="task_pause"),
        Route("POST", "/v1/tasks/{task_id}/resume", _h_task_resume, operation_id="task_resume"),
        Route(
            "POST",
            "/v1/robot/follow",
            _h_follow,
            operation_id="robot_follow",
            requires_approval=True,
        ),
        Route(
            "POST",
            "/v1/robot/speak",
            _h_speak,
            operation_id="robot_speak",
            requires_approval=True,
        ),
        Route(
            "POST",
            "/v1/robot/announce",
            _h_announce,
            operation_id="robot_announce",
        ),
        Route("POST", "/v1/speech/listen", _h_listen, operation_id="speech_listen"),
        Route("POST", "/v1/speech/abort", _h_speech_abort, operation_id="speech_abort"),
        Route("GET", "/v1/audio/state", _h_audio_state, operation_id="audio_state"),
        Route("POST", "/v1/audio/mute", _h_audio_mute, operation_id="audio_mute"),
        Route("POST", "/v1/audio/unmute", _h_audio_unmute, operation_id="audio_unmute"),
        Route(
            "GET",
            "/v1/robot/odometry/calibration",
            _h_calib_get,
            operation_id="robot_calibration_get",
        ),
        Route(
            "POST",
            "/v1/robot/odometry/calibration",
            _h_calib_set,
            operation_id="robot_calibration_set",
            requires_approval=True,
        ),
    ]
    if debug:
        # 只保留「看」与「直发板侧 op」两类旁路。
        # 旧 POC 的 /v1/debug/call、/v1/debug/model 等**已删除**：前者能把内部能力
        # 绕过公开工具面完全调用，后者把任意 OpenAI 兼容请求直通 modeld——
        # 两者都是后门，不是诊断能力。要看内部能力清单走 /v1/debug/state。
        routes += [
            Route("POST", "/v1/debug/serial", _h_debug_serial, operation_id="debug_serial"),
            Route("GET", "/v1/debug/state", _h_debug_state, operation_id="debug_state"),
            Route("GET", "/v1/debug/events", _h_debug_events, operation_id="debug_events"),
        ]
    return routes


PUBLIC_OPERATION_IDS = frozenset(
    r.operation_id for r in build_routes(debug=False) if not r.template.startswith("/v1/debug")
)
DEBUG_OPERATION_IDS = frozenset(r.operation_id for r in build_routes(debug=True)) - PUBLIC_OPERATION_IDS


# ===================================================================== HTTP 服务器
class RobotdHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        *,
        app: App,
        routes: list[Route],
        debug: bool,
    ) -> None:
        self.app = app
        self.routes = routes
        self.debug = debug
        self.ws_connections = 0
        self._ws_lock = threading.Lock()
        super().__init__(server_address, _RobotdHandler, bind_and_activate=True)
        # IPv6 回环地址需要 AF_INET6
        if ":" in server_address[0] and self.address_family is socket.AF_INET:
            self.address_family = socket.AF_INET6

    def track_ws(self, delta: int) -> None:
        with self._ws_lock:
            self.ws_connections = max(0, self.ws_connections + delta)

    def handle_error(self, request: Any, client_address: Any) -> None:
        """连接级异常只记日志，不打印整段 traceback。

        WS 升级后的 socket 由本模块自己管理；对端硬断开时 ``socketserver`` 会走到这里。
        这是正常事件（浏览器关页面 / 测试断开），不是缺陷。
        """
        import sys

        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
            log.info("连接异常结束 %s：%s", client_address, exc)
            return
        super().handle_error(request, client_address)


class _RobotdHandler(BaseHTTPRequestHandler):
    server: RobotdHTTPServer = None  # type: ignore[assignment]
    protocol_version = "HTTP/1.1"
    server_version = "robotd/0.1"
    sys_version = ""

    # ------------------------------------------------------------ 日志
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        log.debug("%s - %s", self.address_string(), fmt % args)

    # ------------------------------------------------------------ 写响应
    def _write_json(self, status: int, body: Any, *, extra_headers: dict[str, str] | None = None) -> None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        # robotd 只被本机同源 UI / agentd 消费；不放通配 CORS
        self.send_header("x-content-type-options", "nosniff")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _write_error(self, err: RobotdError) -> None:
        self._write_json(err.http_status, err.to_public())

    # ------------------------------------------------------------ 判据
    def _host_allowed(self) -> bool:
        host = (self.headers.get("host") or "").strip()
        if not host:
            return True  # HTTP/1.0 无 Host：仅回环监听，不作安全边界
        hostname = host
        if hostname.startswith("["):
            hostname = hostname[1 : hostname.find("]")] if "]" in hostname else hostname
        elif ":" in hostname:
            hostname = hostname.rsplit(":", 1)[0]
        return hostname.lower() in _LOOPBACK_HOSTS

    def _is_ws_request(self) -> bool:
        return (self.headers.get("upgrade") or "").lower() == "websocket"

    def _read_body(self) -> dict[str, Any]:
        raw_len = self.headers.get("content-length")
        if raw_len is None:
            return {}
        try:
            length = int(raw_len)
        except ValueError as exc:
            raise RobotdError(ErrorCode.VALIDATION, "Content-Length 不合法") from exc
        if length < 0:
            raise RobotdError(ErrorCode.VALIDATION, "Content-Length 不得为负")
        if length > MAX_BODY_BYTES:
            raise RobotdError(
                ErrorCode.VALIDATION,
                f"请求体超过 {MAX_BODY_BYTES} 字节上限",
                {"content_length": length, "max": MAX_BODY_BYTES},
            )
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RobotdError(ErrorCode.VALIDATION, "请求体不是合法 JSON") from exc
        if not isinstance(parsed, dict):
            raise RobotdError(ErrorCode.VALIDATION, "请求体必须是 JSON 对象")
        return parsed

    # ------------------------------------------------------------ 方法分发
    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch("PUT")

    def do_OPTIONS(self) -> None:  # noqa: N802
        # 不实现 CORS 预检：同源托管，跨源写入必须走本机认证的 agentd 面板，而非 robotd
        self._write_error(RobotdError(ErrorCode.NOT_FOUND, "OPTIONS 不支持：本服务不提供跨源访问"))

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query, keep_blank_values=True)

        if not self._host_allowed():
            self._write_error(
                RobotdError(ErrorCode.VALIDATION, f"拒绝非回环 Host: {self.headers.get('host')}")
            )
            return

        try:
            if path == "/v1/events":
                if self._is_ws_request():
                    self._handle_ws(parsed, query)
                    return
                raise RobotdError(
                    ErrorCode.VALIDATION,
                    "/v1/events 只能升级为 WebSocket；请用 ws:// 连接",
                )

            route: Route | None = None
            params: dict[str, str] = {}
            for r in self.server.routes:
                m = r.match(method, path)
                if m is not None:
                    route = r
                    params = m
                    break
            if route is None:
                known = any(r.match(m, path) is not None for r in self.server.routes)
                if known:
                    raise RobotdError(ErrorCode.NOT_FOUND, f"{path} 不支持 {method}")
                raise RobotdError(ErrorCode.NOT_FOUND, f"无此路由 {method} {path}")

            body = self._read_body() if method in {"POST", "PUT"} else {}
            ctx = RouteContext(
                app=self.server.app,
                method=method,
                path=path,
                query=query,
                params=params,
                body=body,
                handler=self,
            )
            if route.requires_approval:
                _enforce_approval(ctx, route)
            result = route.fn(ctx)
            self._write_json(200, result)
        except RobotdError as err:
            self._write_error(err)
        except Exception as exc:  # noqa: BLE001
            log.exception("处理 %s %s 时未分类异常", method, path)
            self._write_error(wrap_unexpected(exc))

    # ------------------------------------------------------------ WebSocket
    def _handle_ws(self, parsed: Any, query: dict[str, list[str]]) -> None:
        headers = {k.lower(): v for k, v in self.headers.items()}
        try:
            hs = parse_handshake(headers, parsed.path)
        except WsProtocolError as exc:
            self._write_error(RobotdError(ErrorCode.VALIDATION, str(exc)))
            return

        # 手动写 101 响应：不用 send_response()，因为它会额外塞 Server/Date 头并让
        # Connection 头出现两次（客户端可能据此误判）。101 只需要这四行。
        from .ws import compute_accept

        accept = compute_accept(hs.key)
        self.wfile.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                "\r\n"
            ).encode("ascii")
        )
        try:
            self.wfile.flush()
        except OSError:
            return

        sock = self.connection
        # BaseHTTPRequestHandler 会把 connection 包一层；升级后必须直接操作原始 socket
        ws_sock = sock
        if hasattr(sock, "unwrap"):
            try:
                ws_sock = sock.unwrap()
            except (OSError, ValueError):
                ws_sock = sock
        self.close_connection = True
        self.server.track_ws(+1)
        try:
            # 传**已解析**的 query：events.serve_ws 直接按 dict 取（早期版本传原始字符串导致崩溃）
            events_api.serve_ws(self.server.app, ws_sock, hs, query)
        except Exception as exc:  # noqa: BLE001
            log.warning("WS 会话异常结束：%s", exc)
        finally:
            self.server.track_ws(-1)


def serve(app: App, *, bind: str, port: int, debug: bool = False) -> RobotdHTTPServer:
    """创建并返回**已 bind 但未开始 accept** 的服务器，调用方负责 ``serve_forever()``。"""
    routes = build_routes(debug=debug)
    server = RobotdHTTPServer((bind, port), app=app, routes=routes, debug=debug)
    return server

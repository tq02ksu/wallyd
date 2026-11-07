"""语音运行时（R14）：把桥的原始事件翻译成契约里的 ``speech.*`` / ``audio.state``。

## 分工

- **桥**（``AudioBridge.app``）只管「听得见 / 说得清」：采集、AEC、VAD、ASR、合成、播放。
  它吐自己的事件名（``ready`` / ``partial`` / ``final`` / ``tts_chunk_started`` …）。
- **本模块**管契约：utterance 生命周期、revision 单调、``no_speech`` 判定、打断仲裁、
  ``audio.state`` 快照。**robotd 不解析自然语言**（R14 最后一条），只负责把结构化事件给 agentd。

## 什么算「没听清」

R14 明确要求「缺权限 / 空音频 / 桥退出不能伪装为成功听音」。这里的落点：

| 情况 | ``speech.final`` 的表示 |
| --- | --- |
| 真的没人说话（VAD 全程静音） | ``text: ""`` + ``no_speech: true`` + ``stop_reason: "silence"`` |
| 说话窗口内识别为空 | ``text: ""`` + ``no_speech: true`` + ``stop_reason: "empty"`` |
| 桥中途退出 | **不发 final**，任务以 ``failed`` 收尾（``reason: "bridge_exit"``） |
| 用户取消 / 静音 | ``stop_reason: "cancelled"``，不算失败 |

把「桥挂了」写成 ``no_speech`` 是最坏的伪装：agentd 会以为用户没吭声。
"""

from __future__ import annotations

import logging
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from ..core.types import DeviceStatus, now_ms

log = logging.getLogger("robotd.audio")


@dataclass
class Utterance:
    """一轮「听」的运行时状态。"""

    utterance_id: str
    task_id: str | None
    #: True = 桥的 VAD 在常听模式下自动开启，而不是 ``POST /v1/speech/listen`` 发起
    auto: bool = False
    revision: int = 0
    partial: str | None = None
    speech_ms: int | None = None
    silence_ms: int | None = None
    saw_speech: bool = False
    errored: str | None = None
    cancelled: bool = False


@dataclass
class Response:
    """一轮播报。``chunks`` 是分句数，用于 ``tts_finished.played`` 统计。

    ``approval_id`` / ``kind`` 只有系统审批播报才有：它们让 agentd 能在事件流里
    认出「这一轮是哪个审批的复述」，而不是靠本地猜。
    """

    response_id: str
    task_id: str | None
    approval_id: str | None = None
    kind: str | None = None
    chunks: int = 0
    played: int = 0
    started_chunks: set[int] = field(default_factory=set)
    cancelled: bool = False


class AudioRuntime:
    """持有桥句柄与语音状态；所有状态写入经 ``emit``（内核 emit 的薄包装）。"""

    def __init__(self, *, emit: Callable[[str, dict[str, Any]], None]) -> None:
        self._emit = emit
        self._lock = threading.RLock()
        self.bridge: Any | None = None
        self.muted = False
        self.utt: Utterance | None = None
        self.response: Response | None = None
        self.calibrated = False
        self.ambient_db: float | None = None
        self.speech_db: float | None = None
        self.silence_db: float | None = None
        self.mic_format = ""
        self.last_final: str | None = None
        self.last_error: str | None = None
        #: 最近一次 utterance 的终态回调（由 app 注入，用于把任务表收尾）
        self.on_utterance_done: Callable[[Utterance, str, str | None], None] | None = None
        self.on_response_done: Callable[[Response, str], None] | None = None

    # ------------------------------------------------------------ 桥装配
    def attach(self, bridge: Any) -> None:
        with self._lock:
            self.bridge = bridge

    def detach(self) -> None:
        with self._lock:
            self.bridge = None

    @property
    def bridge_status(self) -> DeviceStatus:
        bridge = self.bridge
        if bridge is None:
            return DeviceStatus.UNKNOWN
        status = getattr(bridge, "status", DeviceStatus.UNKNOWN)
        return status if isinstance(status, DeviceStatus) else DeviceStatus.UNKNOWN

    def ready(self) -> bool:
        return self.bridge_status is DeviceStatus.READY

    # ------------------------------------------------------------ 状态快照
    def state(self) -> dict[str, Any]:
        """契约 ``AudioState``。**字段必须齐**，没有数据就填 null/空串，不编估算值。"""
        with self._lock:
            return {
                "mode": "always_on",
                "muted": self.muted,
                "speaking": self.response is not None,
                "bridge": self.bridge_status.value,
                "calibrated": self.calibrated,
                "partial": self.utt.partial if self.utt else None,
                "last_final": self.last_final,
                "ambient_db": self.ambient_db,
                "speech_db": self.speech_db,
                "silence_db": self.silence_db,
                "mic_format": self.mic_format,
                "ts": now_ms(),
            }

    def emit_state(self) -> None:
        self._emit("audio.state", dict(self.state()))

    # ------------------------------------------------------------ 静音
    def set_muted(self, muted: bool) -> dict[str, Any]:
        """静音期间不产生新的识别结果（R14）。当前这轮若在听，立刻取消。"""
        with self._lock:
            self.muted = muted
            bridge = self.bridge
        if bridge is not None and bridge.ready():
            bridge.send({"cmd": "mute" if muted else "unmute"}, best_effort=True)
        if muted:
            self._cancel_utterance(reason="muted")
        self.emit_state()
        return self.state()

    # ------------------------------------------------------------ 听
    def new_utterance(
        self,
        *,
        task_id: str | None,
        locale: str = "zh_CN",
        auto_endpoint: bool = True,
        max_seconds: float = 300.0,
    ) -> Utterance:
        bridge = self.bridge
        if bridge is None or not bridge.ready():
            raise RuntimeError(f"语音桥不可用（{self.bridge_status.value}）：{self._last_error()}")
        with self._lock:
            # 静音期间**不允许开启新一轮识别**（R14：静音期间不产生新的识别结果）。
            # 早期缺陷：静音只拦住了自动切句，显式 `POST /v1/speech/listen` 照常执行，
            # 实测静音后仍产生了识别文本。守门必须放在 runtime——所有入口都经过这里，
            # 包括 HTTP 路由、自动续听与测试。
            if self.muted:
                raise RuntimeError("当前处于静音状态，不会开始新的识别")
            if self.utt is not None:
                # 常听模式下桥可能已经用 VAD 自动开了一轮。显式 listen 直接认领这一轮，
                # 不再发第二个 listen（桥会按 E_BUSY 拒绝，且会让两套 id 对不上）。
                if self.utt.auto and self.utt.task_id is None:
                    self.utt.task_id = task_id
                    return self.utt
                raise RuntimeError("上一轮听还没结束")
            utt = Utterance(utterance_id=f"utt-{uuid.uuid4().hex[:8]}", task_id=task_id)
            self.utt = utt
        cmd = {
            "cmd": "listen",
            "utterance_id": utt.utterance_id,
            "locale": locale,
            "auto_endpoint": auto_endpoint,
            "max_seconds": max_seconds,
        }
        bridge.send(cmd)
        self._emit(
            "speech.ready",
            {
                "utterance_id": utt.utterance_id,
                "task_id": task_id,
                "locale": locale,
                "auto_endpoint": auto_endpoint,
            },
        )
        return utt

    def stop_listening(self, reason: str = "requested") -> None:
        bridge = self.bridge
        if bridge is not None and bridge.ready():
            bridge.send({"cmd": "stop", "reason": reason}, best_effort=True)

    def _cancel_utterance(self, reason: str) -> None:
        with self._lock:
            utt = self.utt
            if utt is None:
                return
            utt.cancelled = True
            self.utt = None
        # 取消也是终态，但要**明确标为取消**而不是「没说话」
        self._emit(
            "speech.final",
            {
                "utterance_id": utt.utterance_id,
                "text": utt.partial or "",
                "stop_reason": reason,
                "no_speech": False,
            },
        )
        if self.on_utterance_done is not None:
            self.on_utterance_done(utt, "cancelled", reason)

    # ------------------------------------------------------------ 播报
    def new_response(
        self,
        *,
        task_id: str | None,
        approval_id: str | None = None,
        kind: str | None = None,
    ) -> Response:
        bridge = self.bridge
        if bridge is None or not bridge.ready():
            raise RuntimeError(f"语音桥不可用（{self.bridge_status.value}）：{self._last_error()}")
        with self._lock:
            resp = Response(
                response_id=f"tts-{uuid.uuid4().hex[:8]}",
                task_id=task_id,
                approval_id=approval_id,
                kind=kind,
            )
            self.response = resp
        return resp

    def speak(
        self,
        resp: Response,
        *,
        text: str,
        voice: str | None = None,
        rate: float | None = None,
        interruptible: bool = True,
    ) -> None:
        bridge = self.bridge
        assert bridge is not None
        cmd: dict[str, Any] = {"cmd": "speak", "text": text, "response_id": resp.response_id}
        if voice:
            cmd["voice"] = voice
        if rate is not None:
            cmd["rate"] = rate
        if not interruptible:
            cmd["interruptible"] = False
        bridge.send(cmd)

    def cancel_speaking(self, reason: str = "interrupted") -> None:
        """打断播报（barge-in）。桥负责真的停下并清空队列。"""
        bridge = self.bridge
        if bridge is not None and bridge.ready():
            bridge.send({"cmd": "stop_speak", "reason": reason}, best_effort=True)

    def abort_response(self, reason: str = "stop") -> None:
        """**本地立即中止**当前播报，并发出 ``speech.tts_cancelled``。

        与 ``cancel_speaking`` 的区别：那个只是通知桥，等桥回报 ``tts_cancelled``；
        本方法用于 ``robot_stop`` 这种安全旁路——用户说「停」要立刻停，不能等桥回应，
        更不能因为桥不可用就静默成功。桥稍后回报的 ``tts_cancelled`` 会因
        ``self.response`` 已清空而被忽略，不会重复发终态事件。
        """
        with self._lock:
            resp = self.response
            self.response = None
        self.cancel_speaking(reason)
        if resp is None:
            return
        self._emit(
            "speech.tts_cancelled",
            self._response_payload(resp, reason=reason, played=resp.played),
        )
        if self.on_response_done is not None:
            self.on_response_done(resp, "cancelled")

    def clear_response(self, resp: Response) -> None:
        """只清理运行时引用，不发终态事件（调用方自己负责失败事件）。"""
        with self._lock:
            if self.response is resp:
                self.response = None

    # ------------------------------------------------------------ 桥事件翻译
    def handle_bridge_event(self, ev: dict[str, Any]) -> None:
        """桥事件 → 契约事件。**未知事件只记日志**，不伪造语义。"""
        name = ev.get("ev")
        if name == "bridge_ready":
            with self._lock:
                self.mic_format = str(ev.get("asr_format") or "")
                self.last_error = None
            return
        if name == "ready":
            self._adopt_auto_utterance(ev)
            return
        if name == "vad_calibrated":
            with self._lock:
                self.calibrated = True
                self.ambient_db = _num(ev.get("ambient_db"))
                self.speech_db = _num(ev.get("speech_db"))
                self.silence_db = _num(ev.get("silence_db"))
            self.emit_state()
            return
        if name == "speech_state":
            # 桥的 VAD 判出「开始说了」
            if str(ev.get("state")) == "speech":
                with self._lock:
                    utt = self._utterance_for(ev)
                    if utt is not None and not utt.saw_speech:
                        utt.saw_speech = True
                        self._emit(
                            "speech.started",
                            {
                                "utterance_id": utt.utterance_id,
                                "task_id": utt.task_id,
                                "rms_db": _num(ev.get("rms_db")),
                            },
                        )
                        # barge-in：用户开口 → 停掉正在播的话
                        if self.response is not None:
                            self.cancel_speaking("barge_in")
            return
        if name == "partial":
            with self._lock:
                utt = self._utterance_for(ev)
                if utt is None:
                    return
                utt.revision += 1
                utt.partial = str(ev.get("text") or "")
                revision = utt.revision
                uid = utt.utterance_id
            self._emit(
                "speech.partial",
                {"utterance_id": uid, "revision": revision, "text": self.utt.partial if self.utt else ""},
            )
            return
        if name == "endpoint":
            with self._lock:
                utt = self._utterance_for(ev)
                if utt is None:
                    return
                utt.speech_ms = _int(ev.get("speech_ms"))
                utt.silence_ms = _int(ev.get("silence_ms"))
                uid = utt.utterance_id
                s_ms, sil_ms = utt.speech_ms, utt.silence_ms
            self._emit(
                "speech.endpoint",
                {
                    "utterance_id": uid,
                    "reason": str(ev.get("reason") or "silence"),
                    "speech_ms": s_ms,
                    "silence_ms": sil_ms,
                },
            )
            return
        if name == "final":
            self._finish_utterance(ev)
            return
        if name == "tts_started":
            self._tts_started(ev)
            return
        if name == "tts_chunk_started":
            self._tts_chunk(ev, started=True)
            return
        if name == "tts_chunk_finished":
            self._tts_chunk(ev, started=False)
            return
        if name in {"tts_finished", "tts_cancelled"}:
            self._tts_done(ev, cancelled=(name == "tts_cancelled"))
            return
        if name == "bridge_exit":
            self._on_bridge_exit(str(ev.get("reason") or "桥退出"))
            return
        if name == "error":
            with self._lock:
                self.last_error = str(ev.get("message") or ev.get("code") or "桥报错")
            log.warning("语音桥错误：%s", self.last_error)

    def _utterance_for(self, ev: dict[str, Any]) -> Utterance | None:
        """只返回事件对应的一轮。

        桥在常听模式下会连续自动开启多轮；旧轮迟到的 partial/final 绝不能写进新轮。
        事件没带 utterance_id 时保持旧行为，避免把兼容路径误伤。
        """
        utt = self.utt
        if utt is None:
            return None
        event_id = ev.get("utterance_id")
        if event_id is None or str(event_id) == utt.utterance_id:
            return utt
        log.debug("忽略 %s 的迟到事件：当前轮是 %s", event_id, utt.utterance_id)
        return None

    def _adopt_auto_utterance(self, ev: dict[str, Any]) -> None:
        """把桥用 VAD 自动开的一轮认领到运行时。

        没有这一步，``utt-auto-*`` 的 partial/final 会因为运行时没有当前轮而被丢掉——
        「一直在听」就只剩桥自己在听。
        """
        utterance_id = str(ev.get("utterance_id") or "")
        if not utterance_id:
            return
        with self._lock:
            if self.muted:
                return
            current = self.utt
            if current is not None:
                # 显式 listen 会先创建同 id 的轮，再收到桥的 ready；自动轮则直接认领。
                return
            utt = Utterance(utterance_id=utterance_id, task_id=None, auto=True)
            self.utt = utt
        self._emit(
            "speech.ready",
            {
                "utterance_id": utt.utterance_id,
                "task_id": None,
                "locale": str(ev.get("locale") or "zh_CN"),
                "auto_endpoint": bool(ev.get("auto_endpoint", True)),
            },
        )

    # ------------------------------------------------------------ 各事件细节
    def _finish_utterance(self, ev: dict[str, Any]) -> None:
        with self._lock:
            utt = self._utterance_for(ev)
            if utt is self.utt:
                self.utt = None
        if utt is None:
            return
        text = str(ev.get("text") or "").strip()
        # 桥显式给了 no_speech 就尊重它：engine_unavailable 会带 text="" + no_speech=false，
        # 这种情况是失败，不是「用户没说话」。只在字段缺失时才按空文本推断。
        explicit_no_speech = ev.get("no_speech")
        no_speech = bool(explicit_no_speech) if explicit_no_speech is not None else not text
        stop_reason = str(ev.get("stop_reason") or ("silence" if not utt.saw_speech else "endpoint"))
        if no_speech and not utt.saw_speech and stop_reason not in {"engine_unavailable"}:
            stop_reason = "silence"
        if text:
            with self._lock:
                self.last_final = text
        self._emit(
            "speech.final",
            {
                "utterance_id": utt.utterance_id,
                "text": text,
                "stop_reason": stop_reason,
                "no_speech": no_speech,
            },
        )
        if self.on_utterance_done is not None:
            failed = stop_reason in {"engine_unavailable", "engine_error"}
            self.on_utterance_done(utt, "failed" if failed else "completed", stop_reason if failed else None)

    def _tts_started(self, ev: dict[str, Any]) -> None:
        resp = self.response
        if resp is None:
            return
        resp.chunks = int(ev.get("chunks") or 0)
        self._emit(
            "speech.tts_started",
            self._response_payload(resp, voice=str(ev.get("voice") or ""), chunks=resp.chunks),
        )

    def _tts_chunk(self, ev: dict[str, Any], *, started: bool) -> None:
        resp = self.response
        if resp is None:
            return
        index = int(ev.get("index") or 0)
        if started:
            resp.started_chunks.add(index)
        else:
            resp.played += 1
        self._emit(
            "speech.tts_chunk_started" if started else "speech.tts_chunk_finished",
            {"response_id": resp.response_id, "index": index},
        )

    def _tts_done(self, ev: dict[str, Any], *, cancelled: bool) -> None:
        with self._lock:
            resp = self.response
            self.response = None
        if resp is None:
            return
        # 桥会自报 chunks/played；以桥为准（它才是数了句数的那一方）。
        chunks = int(ev.get("chunks") or resp.chunks)
        played = int(ev.get("played") if ev.get("played") is not None else resp.played)
        if cancelled:
            self._emit(
                "speech.tts_cancelled",
                self._response_payload(resp, reason=str(ev.get("reason") or "interrupted"), played=played),
            )
        else:
            self._emit(
                "speech.tts_finished",
                self._response_payload(resp, chunks=chunks, played=played),
            )
        if self.on_response_done is not None:
            self.on_response_done(resp, "cancelled" if cancelled else "completed")

    def _on_bridge_exit(self, reason: str) -> None:
        """桥退出：**不伪装**。当前 utterance 判失败，播报判取消。"""
        with self._lock:
            self.last_error = reason
            utt, self.utt = self.utt, None
            resp, self.response = self.response, None
        if utt is not None:
            self._emit(
                "speech.final",
                {
                    "utterance_id": utt.utterance_id,
                    "text": utt.partial or "",
                    "stop_reason": "bridge_exit",
                    "no_speech": False,
                },
            )
            if self.on_utterance_done is not None:
                self.on_utterance_done(utt, "failed", "bridge_exit")
        if resp is not None:
            self._emit(
                "speech.tts_cancelled",
                self._response_payload(resp, reason="bridge_exit", played=resp.played),
            )
            if self.on_response_done is not None:
                self.on_response_done(resp, "failed")
        self.emit_state()

    @staticmethod
    def _response_payload(resp: Response, **extra: Any) -> dict[str, Any]:
        """播报事件的公共字段：``response_id`` + 可选关联键。

        ``task_id`` / ``approval_id`` / ``kind`` 只在有值时出现：用 null 表示
        「不适用」会让下游多一种要处理的形状。
        """
        payload: dict[str, Any] = {"response_id": resp.response_id, **extra}
        if resp.task_id:
            payload["task_id"] = resp.task_id
        if resp.approval_id:
            payload["approval_id"] = resp.approval_id
        if resp.kind:
            payload["kind"] = resp.kind
        return payload

    def _last_error(self) -> str:
        bridge = self.bridge
        if bridge is None:
            return "未装配语音桥"
        return str(getattr(bridge, "last_error", None) or "未知")


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)

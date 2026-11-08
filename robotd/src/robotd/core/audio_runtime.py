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

#: 判定「AEC 真的在压回声」的 ERLE 底线**默认值**（dB）。
#:
#: V03 由 6.0 → 20.0（见 ``docs/design/GH-6.md`` §4）：AEC3 两次真实录音的 P10 是
#: +31.2 / +32.0 dB。20 dB 比 P10 低约 11 dB，仍能接纳实时抖动的较差帧；而 6 dB 会把
#: 「几乎没压」的样本当成可用判据，在换 AEC3 后放进假收敛帧。**方向仍是保守**：
#: 低于底线 → ``no_erle`` → 不打断。
#:
#: 生效值来自 ``Config.barge_in_erle_floor_db``（可配置文件 / 环境变量覆盖），
#: 并通过 ``GET /v1/audio/state`` 回显——真机复核时不必翻代码。
#:
#: 注意：agentd 审批 settle 的 ``ECHO_ERLE_MAX_DB`` 仍是 6 dB，语义不同（那句话是不是
#: 回声），不随本常量变化。
DEFAULT_BARGE_IN_ERLE_FLOOR_DB = 20.0

#: ``aec_echo_probe`` 的 ERLE 事实最多可用多久（ms）。更早的探测属于上一轮播报，
#: 拿来判本轮的打断会误伤。
BARGE_IN_ERLE_MAX_AGE_MS = 1000

#: 默认 ``erle_margin``（dB）：AEC 回声残余相对本底的最大值 + 安全余量。
#:
#: V03 由 30.0 → 15.0（推导见 ``docs/design/GH-6.md`` §4）：无 AEC 回声的 P90 是
#: +38.5 dB 相对本底，AEC3 的 P10 ERLE 是 +31.2 dB，两者相减得到差侧回声残余约
#: +7.3 dB，再加约 8 dB 安全余量。旧值 30 来自 VPIO 最坏 +26.9 dB + 3 dB。
#:
#: **这是离线证据支持的暂定值**：r2 的最坏单窗只有 +9.7 dB ERLE，说明个别窗仍可能
#: 需要 30 dB。真机 30 分钟 0 误触发（GH-6 判据 3）未验证；若出现自听误触发，
#: 按设计文档回退到 30 dB，而不是继续压门限。
DEFAULT_BARGE_IN_ERLE_MARGIN_DB = 15.0


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
    #: 收到 ``tts_chunk_finished`` 的块数。打断对账的 ``finished_n`` 就是它。
    finished_chunks: int = 0
    #: 桥 ``tts_played`` 事实里的块索引（**真的播完了**的块）。
    played_chunks: set[int] = field(default_factory=set)
    #: 桥是否上报过 ``tts_played``。老桥没有这个事实时退回「finished 即 played」的兼容口径。
    saw_played: bool = False
    #: 桥的有界队列因满丢弃的块数（背压事实）。**不计入** ``dropped``（GH-6 D3）。
    queue_dropped: int = 0
    cancelled: bool = False


class AudioRuntime:
    """持有桥句柄与语音状态；所有状态写入经 ``emit``（内核 emit 的薄包装）。"""

    def __init__(
        self,
        *,
        emit: Callable[[str, dict[str, Any]], None],
        barge_in_erle_margin_db: float = DEFAULT_BARGE_IN_ERLE_MARGIN_DB,
        barge_in_erle_floor_db: float = DEFAULT_BARGE_IN_ERLE_FLOOR_DB,
        barge_in_erle_overridden: tuple[str, ...] | list[str] = (),
    ) -> None:
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
        #: 桥最近一次 aec_echo_probe 的 ERLE 估计（事实，不是判定）。
        self.last_erle_db: float | None = None
        self.last_erle_ms: int = 0
        #: 同一次 probe 的渲染电平（ERLE 的参考侧事实）。
        self.last_render_db: float | None = None
        #: 打断门限里「回声残余相对本底 + 安全余量」的可调项（dB）。
        self.barge_in_erle_margin_db = float(barge_in_erle_margin_db)
        #: ``aec_erle_db`` 可作为判据的可用性底线（dB），同样来自配置。
        self.barge_in_erle_floor_db = float(barge_in_erle_floor_db)
        #: 哪几项门限被显式配置覆盖（``"margin"`` / ``"floor"``），用于状态回显。
        self.barge_in_erle_overridden = tuple(barge_in_erle_overridden)
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
                "barge_in_erle_margin_db": self.barge_in_erle_margin_db,
                "barge_in_erle_floor_db": self.barge_in_erle_floor_db,
                "barge_in_erle_overridden": list(self.barge_in_erle_overridden),
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

    def abort_speaking(self, *, response_id: str | None = None, reason: str = "user_cancel") -> bool:
        """``POST /v1/speech/abort`` 的落点：中止播报，**无活动播报时幂等**。

        返回是否真的中止了一轮。与 :meth:`abort_response` 的区别只在语义：
        本方法是用户显式的「停止播报」（``user_cancel``），而 ``abort_response`` 还被
        ``robot_stop`` / barge-in 复用。``response_id`` 给了就只停对应那一轮，
        不匹配时不误伤别的播报。无活动播报时仍尽力通知桥清队列，但不算中止。
        """
        with self._lock:
            resp = self.response
        if resp is None:
            if response_id is None:
                self.cancel_speaking(reason)
            return False
        if response_id is not None and response_id != resp.response_id:
            return False
        self.abort_response(reason)
        return True

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
        played, dropped = self._settle_counts(resp)
        self._emit(
            "speech.tts_cancelled",
            self._response_payload(resp, reason=reason, played=played, **self._count_extra(dropped, resp)),
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
        if name == "aec_echo_probe":
            # 只记事实。两件事分属两层，别混成一句：
            #   - 「这一轮是不是回声」（审批 settle 的证据）归 agentd；
            #   - 「要不要因此打断播报」归 robotd 的 AudioRuntime（本文件），由
            #     `_on_vad_speech()` 用下面的 ERLE 事实与可调门限判定。
            erle = _num(ev.get("aec_erle_db"))
            if erle is not None:
                with self._lock:
                    self.last_erle_db = erle
                    self.last_erle_ms = now_ms()
                    render = _num(ev.get("render_db"))
                    if render is not None:
                        self.last_render_db = render
            return
        if name == "speech_state":
            # 桥的 VAD 判出「开始说了」。播报期间也会到这里（桥不再一刀切），
            # 是否真的打断由本模块的 `_on_vad_speech()` 决定。
            if str(ev.get("state")) == "speech":
                self._on_vad_speech(ev)
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
        if name == "tts_played":
            self._tts_played(ev)
            return
        if name == "tts_chunk_dropped":
            # 桥的有界队列背压事实。**不计入 ``dropped``**（GH-6 D3）：``dropped`` 是
            # 「合成完成却未播出」（finished_n − played），队列满丢弃是桥的另一维事实，
            # 单列在 ``queue_dropped``。取消时清队列产生的丢弃同理：它已经体现在
            # finished_n − played 里，不重复计数。契约不新增事件类型。
            if str(ev.get("reason") or "") != "queue_full":
                return
            with self._lock:
                resp = self.response
                if resp is not None:
                    resp.queue_dropped += 1
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

    def _adopt_auto_utterance(self, ev: dict[str, Any]) -> Utterance | None:
        """把桥用 VAD 自动开的一轮认领到运行时。

        没有这一步，``utt-auto-*`` 的 partial/final 会因为运行时没有当前轮而被丢掉——
        「一直在听」就只剩桥自己在听。

        播报期间 probe VAD 的 ``speech_state`` 会先于 ``ready`` 到达；这条路径也用它认领，
        否则「播报中有人开口」的第一个事实会被丢掉，打断永远不可能发生。
        """
        utterance_id = str(ev.get("utterance_id") or "")
        if not utterance_id:
            return None
        with self._lock:
            if self.muted:
                return None
            current = self.utt
            if current is not None:
                # 显式 listen 会先创建同 id 的轮，再收到桥的 ready；自动轮则直接认领。
                # 已经认领过的轮次（probe 事实先到）也在这里返回，不重复发 speech.ready。
                return current if current.utterance_id == utterance_id else None
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
        return utt

    # ------------------------------------------------------------ 打断门控（GH-5 / V02）
    @property
    def speech_db_barge_in(self) -> float | None:
        """打断门限 ``T = max(ambient_db + erle_margin, speech_db)``（dBFS）。

        **唯一的门限算式**：其它模块不得再算一份（``test_barge_in_gate_location.py`` 门禁）。
        未标定（两个电平都缺）时返回 ``None``——宁可保守不打断，也不编一个门限。
        """
        with self._lock:
            ambient = self.ambient_db
            speech = self.speech_db
            margin = self.barge_in_erle_margin_db
        floors: list[float] = []
        if ambient is not None:
            floors.append(ambient + margin)
        if speech is not None:
            floors.append(speech)
        return max(floors) if floors else None

    def _fresh_erle(self) -> tuple[float | None, float | None, float | None]:
        """返回 ``(原始事实, 1 秒内的值, 可用于判定的值)``。

        「可用于判定」= 有值、1 秒内、且不低于生效的 ``barge_in_erle_floor_db``
        （默认 20 dB）。缺失、过期、明确为 0 都落在 ``None``：缺证据 ≠ 有证据（B4）。
        原始值仍然原样回传，供 ``speech.gate`` 如实记录。
        ``speech.started`` 只带 1 秒内的值（更早的探测属于上一轮播报，agentd 拿来判本轮回声会误伤）。
        """
        with self._lock:
            raw = self.last_erle_db
            fresh = raw is not None and now_ms() - self.last_erle_ms <= BARGE_IN_ERLE_MAX_AGE_MS
            fresh_value = raw if fresh else None
            floor = self.barge_in_erle_floor_db
            usable = fresh_value if fresh_value is not None and fresh_value >= floor else None
        return raw, fresh_value, usable

    def _barge_in_verdict(
        self,
        *,
        db: float | None,
        erle: float | None,
        threshold: float | None,
        speaking: bool,
    ) -> tuple[str, str]:
        """判定这次 VAD 上升要不要放行打断。**唯一判定点。**"""
        if not speaking:
            return "pass", "not_speaking"
        if threshold is None:
            return "suppressed", "no_threshold"
        if erle is None:
            return "suppressed", "no_erle"
        if db is None:
            return "suppressed", "no_db"
        if db >= threshold:
            return "pass", "barge_in"
        # 电平在门限之下：仍在播报时，最可能是自己的声音 / 回声残余。
        return "suppressed", "echo"

    def _on_vad_speech(self, ev: dict[str, Any]) -> None:
        """VAD 上升 → 产 ``speech.gate`` → 发 ``speech.started`` → pass 才执行打断。"""
        with self._lock:
            utt = self._utterance_for(ev)
            current = self.utt
        if utt is None:
            if current is not None:
                return
            utt = self._adopt_auto_utterance(ev)
        if utt is None:
            return

        with self._lock:
            if utt.saw_speech:
                # B5：probe VAD 与随后 utterance VAD 是同一轮的两次上升，只判一次。
                return
            utt.saw_speech = True
            db = _num(ev.get("db"))
            if db is None:
                db = _num(ev.get("rms_db"))
            raw_erle, fresh_erle, usable_erle = self._fresh_erle()
            threshold = self.speech_db_barge_in
            speaking = self.response is not None
            decision, reason = self._barge_in_verdict(
                db=db, erle=usable_erle, threshold=threshold, speaking=speaking
            )
            gate: dict[str, Any] = {
                "utterance_id": utt.utterance_id,
                "decision": decision,
                "reason": reason,
            }
            if db is not None:
                gate["db"] = round(db, 1)
            if raw_erle is not None:
                gate["aec_erle_db"] = round(raw_erle, 1)
            if threshold is not None:
                gate["threshold_db"] = round(threshold, 1)
            started: dict[str, Any] = {
                "utterance_id": utt.utterance_id,
                "task_id": utt.task_id,
                "rms_db": None if db is None else round(db, 1),
            }
            if fresh_erle is not None:
                started["aec_erle_db"] = round(fresh_erle, 1)

        # gate 记的是判定结果；started 记的是桥确实开了这一轮。两者都发：
        # suppressed 不发 started 就等于把判定又搬回了桥。
        self._emit("speech.gate", gate)
        self._emit("speech.started", started)
        if decision == "pass" and speaking:
            # 打断是仲裁动作：本地立即中止并清桥的未播队列，不等桥回报。
            self.abort_response("barge_in")

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
            resp.finished_chunks += 1
        self._emit(
            "speech.tts_chunk_started" if started else "speech.tts_chunk_finished",
            {"response_id": resp.response_id, "index": index},
        )

    def _tts_played(self, ev: dict[str, Any]) -> None:
        """桥的「这一块真的播完了」事实。``played`` 只从这类事实累计。

        桥（``mac_speech_pipeline.swift``）在渲染完成后同时发 ``tts_chunk_finished``
        与 ``tts_played``；两者不是同一个量：前者是合成完成，后者是播出完成。
        ``played + dropped == finished_n`` 对账依赖这条区分。
        """
        resp = self.response
        if resp is None:
            return
        index = int(ev.get("index") or 0)
        resp.played_chunks.add(index)
        resp.saw_played = True
        resp.played = len(resp.played_chunks)

    def _tts_done(self, ev: dict[str, Any], *, cancelled: bool) -> None:
        with self._lock:
            resp = self.response
            self.response = None
        if resp is None:
            return
        # 桥会自报 chunks/played；以桥为准（它才是数了句数的那一方）。
        chunks = int(ev.get("chunks") or resp.chunks)
        resp.chunks = chunks or resp.chunks
        hint = ev.get("played")
        played, dropped = self._settle_counts(resp, None if hint is None else int(hint))
        # 桥上报的 ``dropped`` 是**队列满**丢弃数，不是打断计数：归到 queue_dropped。
        resp.queue_dropped = max(resp.queue_dropped, int(ev.get("dropped") or 0))
        extra = self._count_extra(dropped, resp)
        if cancelled:
            self._emit(
                "speech.tts_cancelled",
                self._response_payload(
                    resp,
                    reason=str(ev.get("reason") or "interrupted"),
                    played=played,
                    **extra,
                ),
            )
        else:
            self._emit(
                "speech.tts_finished",
                self._response_payload(resp, chunks=chunks, played=played, **extra),
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
            played, dropped = self._settle_counts(resp)
            self._emit(
                "speech.tts_cancelled",
                self._response_payload(
                    resp,
                    reason="bridge_exit",
                    played=played,
                    **self._count_extra(dropped, resp),
                ),
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

    def _settle_counts(self, resp: Response, played_hint: int | None = None) -> tuple[int, int]:
        """结算 ``(played, dropped)``，锁定 ``played + dropped == finished_n``（GH-6 D3）。

        - ``finished_n``：``tts_chunk_finished`` 计数（合成完成），已知计划句数时截到
          ``chunks``；
        - ``played``：优先用桥的候选值（终态回报里的 ``played``，否则 ``tts_played``
          计数）；老桥没有 ``tts_played`` 时退回「finished 即 played」的兼容口径，
          此时 ``dropped == 0``（不是丢掉失败，而是桥没给这个事实）；
        - ``dropped``：合成完成但因中止未播出的块数 = ``finished_n − played``。

        截断不是掩盖桥的 bug：``finished_chunks > chunks`` 之类的异常会由单测与 eval
        暴露；事件里则不伪造「多播了一句」或「多丢了一块」。
        """
        finished = max(0, int(resp.finished_chunks))
        if played_hint is not None:
            # 终态回报是桥的权威结算：它说播了 n 块，就说明这 n 块已合成完成。
            # 兼容只发终态、不发逐块事件的桥，也避免出现「播了却没合成完成」的矛盾事实。
            finished = max(finished, max(0, int(played_hint)))
        if resp.chunks > 0:
            finished = min(finished, resp.chunks)
        if played_hint is not None:
            played = int(played_hint)
        elif resp.saw_played:
            played = len(resp.played_chunks)
        else:
            played = finished
        played = max(0, min(played, finished))
        return played, finished - played

    @staticmethod
    def _count_extra(dropped: int, resp: Response) -> dict[str, Any]:
        """终态事件里的计数附加字段：只在真有时出现，避免下游多处理一种「恒 0 形状」。"""
        extra: dict[str, Any] = {}
        if dropped:
            extra["dropped"] = dropped
        if resp.queue_dropped:
            extra["queue_dropped"] = resp.queue_dropped
        return extra

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

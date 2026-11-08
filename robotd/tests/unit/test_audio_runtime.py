"""语音运行时的纪律测试（R14）。

只测**不依赖真麦克风**的部分：静音守门与 utterance 生命周期。真实链路
（桥、TCC、VAD、ASR）的验证在 ``eval/r14-voice-bringup-2026-10-24.md``。

保留这些用例的理由：静音守门曾经漏掉显式 ``speech/listen``，实测静音后仍产生
识别文本，违反了 R14「静音期间不产生新的识别结果」。那是**没有测试盯着**才活下来的缺陷。
"""

from __future__ import annotations

import pytest

from robotd.core.announce import render_announcement
from robotd.core.audio_runtime import AudioRuntime
from robotd.core.types import DeviceStatus


class FakeBridge:
    """最小桥替身：只回答 ``ready()`` 并记录收到的命令。"""

    def __init__(self, ready: bool = True) -> None:
        self.status = DeviceStatus.READY if ready else DeviceStatus.LOST
        self._ready = ready
        self.sent: list[dict] = []

    def ready(self) -> bool:
        return self._ready

    def send(self, cmd: dict, best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)


def make_runtime(**kwargs) -> tuple[AudioRuntime, list[tuple[str, dict]]]:
    emitted: list[tuple[str, dict]] = []
    rt = AudioRuntime(emit=lambda t, p: emitted.append((t, p)), **kwargs)
    rt.attach(FakeBridge())
    return rt, emitted


# ---------------------------------------------------------------- 静音守门
def test_muted_runtime_refuses_new_utterance():
    """静音时不得开启新一轮识别——这是 R14 的硬约束。"""
    rt, emitted = make_runtime()
    rt.set_muted(True)

    with pytest.raises(RuntimeError, match="静音"):
        rt.new_utterance(task_id="t-1")

    # 既不能开 utterance，也不能发出 speech.ready（否则调用方会以为真的在听）
    assert rt.utt is None
    assert not [e for e in emitted if e[0] == "speech.ready"]
    # 桥也不该收到 listen 命令
    assert not [c for c in rt.bridge.sent if c.get("cmd") == "listen"]


def test_unmute_restores_listening():
    rt, emitted = make_runtime()
    rt.set_muted(True)
    rt.set_muted(False)

    utt = rt.new_utterance(task_id="t-2")

    assert rt.utt is utt
    assert [e[0] for e in emitted].count("speech.ready") == 1
    # 桥会先收到 mute/unmute（静音本身也要通知桥），最后才是这一轮的 listen
    assert [c["cmd"] for c in rt.bridge.sent] == ["mute", "unmute", "listen"]


def test_mute_cancels_utterance_in_flight():
    """静音的语义是「现在什么都不听」，正在听的那一轮必须收尾成 cancelled。"""
    rt, emitted = make_runtime()
    rt.new_utterance(task_id="t-3")
    rt.set_muted(True)

    finals = [p for t, p in emitted if t == "speech.final"]
    assert len(finals) == 1
    # 实现用 `muted` 而不是笼统的 `cancelled`：能区分「用户静音」与「用户主动取消」，
    # 下游据此可以给出不同提示。两者都是「不是没说话」，绝不能写成 no_speech。
    assert finals[0]["stop_reason"] == "muted"
    assert finals[0]["no_speech"] is False
    assert rt.utt is None


# ---------------------------------------------------------------- 系统播报
def test_announcement_render_uses_fixed_template():
    text = render_announcement(
        kind="approval_repeat",
        action_label="向前跟随",
        args_summary="目标：穿红衣服的人",
    )
    assert "向前跟随" in text
    assert "目标：穿红衣服的人" in text
    assert "确认" in text
    with pytest.raises(ValueError):
        render_announcement(kind="free_speech", action_label="x", args_summary="y")


def test_announcement_events_carry_approval_id_and_complete_only_on_bridge_finish():
    rt, emitted = make_runtime()
    resp = rt.new_response(task_id="t-ann", approval_id="appr-1", kind="approval_repeat")
    rt.speak(resp, text=render_announcement(kind="approval_repeat", action_label="向前", args_summary="两米"))

    # 「请求发出去了」不等于「播完了」：在桥报 tts_finished 之前没有完成事件
    assert not [e for e in emitted if e[0] == "speech.tts_finished"]

    rt.handle_bridge_event({"ev": "tts_started", "chunks": 1})
    started = [p for t, p in emitted if t == "speech.tts_started"][-1]
    assert started["approval_id"] == "appr-1"
    assert started["kind"] == "approval_repeat"

    rt.handle_bridge_event({"ev": "tts_finished", "chunks": 1, "played": 1})
    finished = [p for t, p in emitted if t == "speech.tts_finished"][-1]
    assert finished["approval_id"] == "appr-1"
    assert finished["kind"] == "approval_repeat"
    assert finished["task_id"] == "t-ann"
    assert finished["played"] == 1


def test_speech_started_carries_fresh_aec_erle_db():
    """确认窗口的回声判断需要事实：桥最近 1 秒的 ERLE 要随 speech.started 上报。"""
    rt, emitted = make_runtime()
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-echo-1"})
    rt.handle_bridge_event({"ev": "aec_echo_probe", "aec_erle_db": 2.5, "render_db": -12.0})
    rt.handle_bridge_event({"ev": "speech_state", "state": "speech", "utterance_id": "utt-echo-1"})

    started = [p for t, p in emitted if t == "speech.started"]
    assert len(started) == 1
    assert started[0]["aec_erle_db"] == 2.5


def test_speech_started_omits_stale_aec_erle_db():
    """更早的探测属于上一轮播报，不能拿来判本轮回声。"""
    rt, emitted = make_runtime()
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-echo-2"})
    rt.last_erle_db = 2.5
    rt.last_erle_ms = 0  # 1970：一定过期
    rt.handle_bridge_event({"ev": "speech_state", "state": "speech", "utterance_id": "utt-echo-2"})

    started = [p for t, p in emitted if t == "speech.started"]
    assert len(started) == 1
    assert "aec_erle_db" not in started[0]


def test_abort_response_emits_cancelled_immediately_and_clears_active_response():
    rt, emitted = make_runtime()
    resp = rt.new_response(task_id="t-ann", approval_id="appr-2", kind="approval_repeat")
    rt.speak(resp, text="固定模板")

    rt.abort_response("stop")

    assert rt.response is None
    assert any(c.get("cmd") == "stop_speak" for c in rt.bridge.sent)
    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"]
    assert len(cancelled) == 1
    assert cancelled[0]["approval_id"] == "appr-2"
    assert cancelled[0]["reason"] == "stop"


# ---------------------------------------------------------------- 桥不可用
def test_no_bridge_refuses_utterance():
    rt, _ = make_runtime()
    rt.detach()
    with pytest.raises(RuntimeError, match="语音桥不可用"):
        rt.new_utterance(task_id="t-4")


def test_bridge_not_ready_refuses_utterance():
    rt = AudioRuntime(emit=lambda t, p: None)
    rt.attach(FakeBridge(ready=False))
    with pytest.raises(RuntimeError, match="语音桥不可用"):
        rt.new_utterance(task_id="t-5")


# ---------------------------------------------------------------- 常听自动轮次
def test_bridge_auto_ready_is_adopted_as_utterance():
    """VAD 自动开启的一轮必须被运行时认领，否则 partial/final 会被当成无主事件丢掉。"""
    rt, emitted = make_runtime()

    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1", "source": "mic"})

    assert rt.utt is not None
    assert rt.utt.utterance_id == "utt-auto-1"
    assert rt.utt.task_id is None
    ready = [p for t, p in emitted if t == "speech.ready"]
    assert len(ready) == 1
    assert ready[0]["utterance_id"] == "utt-auto-1"
    assert ready[0]["task_id"] is None


def test_events_for_other_utterance_are_ignored():
    """自动轮次切换后，旧轮的迟到事件不能污染当前轮。"""
    rt, emitted = make_runtime()
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1"})
    rt.handle_bridge_event({"ev": "final", "utterance_id": "utt-auto-1", "text": "旧轮"})
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-2"})

    rt.handle_bridge_event({"ev": "partial", "utterance_id": "utt-auto-1", "text": "迟到"})
    rt.handle_bridge_event({"ev": "speech_state", "state": "speech", "utterance_id": "utt-auto-1"})

    assert rt.utt is not None and rt.utt.utterance_id == "utt-auto-2"
    assert not [p for t, p in emitted if t == "speech.partial"]
    assert not [p for t, p in emitted if t == "speech.started"]
    # probe 的迟到 speech_state 不是一轮语音：不能记成 speech.ignored。
    assert not [p for t, p in emitted if t == "speech.ignored"]


def test_explicit_listen_reuses_in_flight_auto_utterance():
    """显式 listen 不应在常听自动轮已经开启时把桥打成 E_BUSY。"""
    rt, emitted = make_runtime()
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-3"})

    utt = rt.new_utterance(task_id="t-auto")

    assert utt.utterance_id == "utt-auto-3"
    # 复用已有轮次时不再向桥重复发 listen
    assert not [c for c in rt.bridge.sent if c.get("cmd") == "listen"]
    assert rt.utt is utt


def test_engine_unavailable_is_a_failure_not_no_speech():
    """sherpa not-implemented 必须显式失败，不能被空文本重判成「用户没说话」。"""
    rt, emitted = make_runtime()
    done: list[tuple[str, str | None]] = []
    rt.on_utterance_done = lambda _utt, outcome, reason: done.append((outcome, reason))
    rt.new_utterance(task_id="t-engine")

    rt.handle_bridge_event(
        {
            "ev": "final",
            "utterance_id": rt.utt.utterance_id,
            "text": "",
            "stop_reason": "engine_unavailable",
            "no_speech": False,
            "engine_error": "E_ASR_NOT_IMPLEMENTED",
        }
    )

    final = [p for t, p in emitted if t == "speech.final"][-1]
    assert final["no_speech"] is False
    assert final["stop_reason"] == "engine_unavailable"
    assert done == [("failed", "engine_unavailable")]


# ---------------------------------------------------------------- 播报期 VAD 门控（GH-5 / V02）
#: 测试用的标定值：本底 -40 dB、说话门限 -32 dB。默认 erle_margin=15 时
#: ``speech_db_barge_in = max(-40+15, -32) = -25 dB``。
AMBIENT_DB = -40.0
SPEECH_DB = -32.0
BARGE_IN_THRESHOLD_DB = AMBIENT_DB + 15.0


def calibrate(rt: AudioRuntime, *, ambient: float = AMBIENT_DB, speech: float = SPEECH_DB) -> None:
    rt.handle_bridge_event(
        {"ev": "vad_calibrated", "ambient_db": ambient, "speech_db": speech, "silence_db": -38.0}
    )


def probe_erle(rt: AudioRuntime, *, erle: float = 32.0, render: float = -10.0) -> None:
    rt.handle_bridge_event({"ev": "aec_echo_probe", "aec_erle_db": erle, "render_db": render})


def start_speaking(rt: AudioRuntime, *, approval_id: str | None = None, kind: str | None = None):
    resp = rt.new_response(task_id="t-barge", approval_id=approval_id, kind=kind)
    rt.handle_bridge_event({"ev": "tts_started", "chunks": 2, "voice": "v"})
    return resp


def vad_rise(rt: AudioRuntime, *, utterance_id: str = "utt-auto-1", db: float = -5.0) -> None:
    """桥的 probe VAD 上升事实。可能先于 ``ready`` 到达——这正是播报期的形态。"""
    rt.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": utterance_id, "rms_db": db}
    )


def gates(emitted: list[tuple[str, dict]]) -> list[dict]:
    return [p for t, p in emitted if t == "speech.gate"]


def test_barge_in_passes_when_user_speech_exceeds_threshold():
    """A1：播报中用户开口（门限以上、ERLE 新鲜）→ gate pass + 立即停播。"""
    rt, emitted = make_runtime()
    done: list[str] = []
    rt.on_response_done = lambda _resp, outcome: done.append(outcome)
    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt, erle=32.0, render=-10.0)

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "pass"
    assert gate["reason"] == "barge_in"
    assert gate["db"] == -5.0
    assert gate["aec_erle_db"] == 32.0
    assert gate["threshold_db"] == BARGE_IN_THRESHOLD_DB

    # 事实先到、ready 后到：运行时必须认领这一轮，而不是把它丢掉
    assert rt.utt is not None and rt.utt.utterance_id == "utt-auto-1"
    ready = [p for t, p in emitted if t == "speech.ready"]
    assert len(ready) == 1 and ready[0]["utterance_id"] == "utt-auto-1"
    # 桥的 ready 随后到达时不得重复发 ready / started
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1", "source": "vad"})
    assert len([p for t, p in emitted if t == "speech.ready"]) == 1
    started = [p for t, p in emitted if t == "speech.started"]
    assert len(started) == 1
    assert started[0]["utterance_id"] == "utt-auto-1"

    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"]
    assert len(cancelled) == 1
    assert cancelled[0]["reason"] == "barge_in"
    assert rt.response is None
    assert done == ["cancelled"]
    assert [c for c in rt.bridge.sent if c.get("cmd") == "stop_speak"]


def test_barge_in_suppressed_for_self_echo():
    """B1：播报中的自听回声不进人声门限 → gate suppressed/echo，不打断。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    started_resp = start_speaking(rt)
    probe_erle(rt, erle=32.0, render=-10.0)

    # 回声残余（本底 +19.2 dB ≈ -20.8，加余量后仍在 -25 门限之上）
    vad_rise(rt, db=-30.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "suppressed"
    assert gate["reason"] == "echo"
    assert rt.response is started_resp
    assert not [p for t, p in emitted if t == "speech.tts_cancelled"]
    assert not [c for c in rt.bridge.sent if c.get("cmd") == "stop_speak"]
    # 桥确实开了这一轮：robotd 只是不打断，仍然如实发 started
    assert [p for t, p in emitted if t == "speech.started"]


def test_barge_in_right_after_tts_started():
    """A3：刚开始播就有人说话也要打断，不能因为「刚开播」忽略。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt)

    vad_rise(rt, db=-4.0)

    assert gates(emitted)[-1]["decision"] == "pass"
    assert [p for t, p in emitted if t == "speech.tts_cancelled"][-1]["reason"] == "barge_in"


def test_gate_passes_without_playback():
    """B2：没在播报就没有打断对象；gate 记 pass/not_speaking，started 照发。"""
    rt, emitted = make_runtime()
    calibrate(rt)

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "pass"
    assert gate["reason"] == "not_speaking"
    assert [p for t, p in emitted if t == "speech.started"]
    assert not [p for t, p in emitted if t == "speech.tts_cancelled"]


def test_gate_passes_after_tts_finished():
    """B3：播报结束的尾巴不打断（没有播放对象）。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)
    rt.handle_bridge_event({"ev": "tts_finished", "chunks": 2, "played": 2})
    probe_erle(rt)

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "pass"
    assert gate["reason"] == "not_speaking"
    assert not [p for t, p in emitted if t == "speech.tts_cancelled"]


def test_gate_suppressed_without_erle_fact():
    """B4：没有 ERLE 事实 → 缺证据 ≠ 有证据，落在 suppressed/no_erle。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)

    vad_rise(rt, db=-5.0)  # 电平在门限之上也不能放行

    gate = gates(emitted)[-1]
    assert gate["decision"] == "suppressed"
    assert gate["reason"] == "no_erle"
    assert "aec_erle_db" not in gate
    assert rt.response is not None
    assert not [c for c in rt.bridge.sent if c.get("cmd") == "stop_speak"]


def test_gate_suppressed_when_erle_probe_is_stale():
    """B4：上次探测超过 1000ms → 同样 no_erle。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)
    rt.last_erle_db = 12.0
    rt.last_erle_ms = 0  # 1970：一定过期

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "suppressed"
    assert gate["reason"] == "no_erle"
    assert rt.response is not None


def test_explicit_zero_erle_follows_the_same_no_evidence_path():
    """判据 3：ERLE 缺失与「明确为 0」走同一条路——都不能被当成「AEC 压住了」。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt, erle=0.0, render=-10.0)
    # 0 是真实值，不能被 `or None` 吞掉
    assert rt.last_erle_db == 0.0

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "suppressed"
    assert gate["reason"] == "no_erle"
    assert gate["aec_erle_db"] == 0.0
    assert rt.response is not None


def test_gate_suppressed_when_not_calibrated():
    """没标定就没有门限：仍要产 gate，但不能放行。"""
    rt, emitted = make_runtime()
    start_speaking(rt)
    probe_erle(rt)

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["decision"] == "suppressed"
    assert gate["reason"] == "no_threshold"
    assert "threshold_db" not in gate
    assert rt.response is not None


def test_repeated_vad_rise_emits_one_gate_per_utterance():
    """B5：同一 utterance 内重复 speech（probe 与 utterance VAD）只判一次。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt)

    vad_rise(rt, db=-5.0)
    vad_rise(rt, db=-5.0)

    assert len(gates(emitted)) == 1
    assert len([p for t, p in emitted if t == "speech.started"]) == 1
    assert len([p for t, p in emitted if t == "speech.tts_cancelled"]) == 1


def test_every_vad_rise_emits_a_gate():
    """判据 5：pass 与 suppressed 都要有 gate，压掉的才在时间线上有分母。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt)
    vad_rise(rt, utterance_id="utt-auto-1", db=-30.0)  # echo → suppressed
    rt.handle_bridge_event({"ev": "final", "utterance_id": "utt-auto-1", "text": "", "no_speech": True})
    vad_rise(rt, utterance_id="utt-auto-2", db=-5.0)  # user → pass

    decisions = [g["decision"] for g in gates(emitted)]
    assert decisions == ["suppressed", "pass"]


def test_approval_repeat_barge_in_cancels_without_tts_finished():
    """A2：审批复述被打断时只发 tts_cancelled（played 未增加），不冒充播完。"""
    rt, emitted = make_runtime()
    calibrate(rt)
    start_speaking(rt, approval_id="appr-1", kind="approval_repeat")
    probe_erle(rt)

    vad_rise(rt, db=-5.0)

    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"]
    assert len(cancelled) == 1
    assert cancelled[0]["reason"] == "barge_in"
    assert cancelled[0]["approval_id"] == "appr-1"
    assert cancelled[0]["kind"] == "approval_repeat"
    assert not [p for t, p in emitted if t == "speech.tts_finished"]


# ---------------------------------------------------------------- 显式停止播报（GH-6）
def test_speech_abort_without_active_playback_is_idempotent():
    """判据 5：无活动播报时也返回「已受理」，连说两次「停」不会 404。"""
    rt, emitted = make_runtime()

    assert rt.abort_speaking(reason="user_cancel") is False
    assert rt.abort_speaking(reason="user_cancel") is False

    # 没有播报对象就没有 tts_cancelled：不伪造一轮从来没开始的播报。
    assert not [p for t, p in emitted if t == "speech.tts_cancelled"]


def test_speech_abort_stops_only_the_matching_response_id():
    rt, emitted = make_runtime()
    resp = start_speaking(rt, approval_id="appr-1", kind="approval_repeat")

    assert rt.abort_speaking(response_id="tts-other", reason="user_cancel") is False
    assert rt.response is resp
    assert not [p for t, p in emitted if t == "speech.tts_cancelled"]

    assert rt.abort_speaking(response_id=resp.response_id, reason="user_cancel") is True
    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"]
    assert len(cancelled) == 1
    # 判据：barge_in 与 user_cancel 必须能区分（同一事件、不同 reason）。
    assert cancelled[0]["reason"] == "user_cancel"
    assert rt.response is None


def test_barge_in_counting_is_self_consistent():
    """判据 2：played ≤ chunks，finished_n ≤ started_n ≤ chunks，且 played ≤ finished_n。"""
    rt, emitted = make_runtime()
    resp = start_speaking(rt)
    assert resp.chunks == 2

    # 第 0 块完成合成并播出；第 1 块还在飞。
    rt.handle_bridge_event({"ev": "tts_chunk_started", "index": 0})
    rt.handle_bridge_event({"ev": "tts_chunk_finished", "index": 0})
    rt.handle_bridge_event({"ev": "tts_chunk_started", "index": 1})

    calibrate(rt)
    probe_erle(rt)
    vad_rise(rt, db=-5.0)

    chunks = [p for t, p in emitted if t == "speech.tts_started"][-1]["chunks"]
    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"][-1]
    started_n = len([p for t, p in emitted if t == "speech.tts_chunk_started"])
    finished_n = len([p for t, p in emitted if t == "speech.tts_chunk_finished"])
    played = cancelled["played"]

    assert cancelled["reason"] == "barge_in"
    assert played <= chunks
    assert finished_n <= started_n <= chunks
    assert played <= finished_n
    assert (played, finished_n, started_n, chunks) == (1, 1, 2, 2)


def test_queue_full_drops_are_reported_separately_from_dropped():
    """GH-6 D3：队列满丢弃是桥的背压事实，不混进打断计数。"""
    rt, emitted = make_runtime()
    start_speaking(rt)
    rt.handle_bridge_event({"ev": "tts_chunk_started", "index": 0})
    rt.handle_bridge_event({"ev": "tts_chunk_finished", "index": 0})
    rt.handle_bridge_event({"ev": "tts_played", "index": 0, "played": 1})
    rt.handle_bridge_event({"ev": "tts_chunk_dropped", "index": 1, "reason": "queue_full"})

    rt.abort_speaking(reason="user_cancel")

    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"][-1]
    assert cancelled["played"] == 1
    # finished_n == played == 1：没有「合成完成却未播出」的块，dropped 不出现。
    assert "dropped" not in cancelled
    assert cancelled["queue_dropped"] == 1
    assert not [t for t, _p in emitted if t == "speech.tts_chunk_dropped"]


def test_barge_in_reconciles_played_dropped_against_finished():
    """本轮判据 3：播完一部分后 barge-in → ``played + dropped == finished_n``。"""
    rt, emitted = make_runtime()
    resp = start_speaking(rt)  # 计划 2 句
    assert resp.chunks == 2
    # 第 0 块合成完成并播出；第 1 块只合成完成（还在渲染队列里没播）。
    rt.handle_bridge_event({"ev": "tts_chunk_started", "index": 0})
    rt.handle_bridge_event({"ev": "tts_chunk_finished", "index": 0})
    rt.handle_bridge_event({"ev": "tts_played", "index": 0, "played": 1})
    rt.handle_bridge_event({"ev": "tts_chunk_started", "index": 1})
    rt.handle_bridge_event({"ev": "tts_chunk_finished", "index": 1})

    calibrate(rt)
    probe_erle(rt)
    vad_rise(rt, db=-5.0)

    chunks = [p for t, p in emitted if t == "speech.tts_started"][-1]["chunks"]
    finished_n = len([p for t, p in emitted if t == "speech.tts_chunk_finished"])
    started_n = len([p for t, p in emitted if t == "speech.tts_chunk_started"])
    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"][-1]

    assert cancelled["reason"] == "barge_in"
    played = cancelled["played"]
    assert played == 1
    assert cancelled["dropped"] == 1
    assert played + cancelled["dropped"] == finished_n == 2
    assert finished_n <= started_n <= chunks == 2


def test_cancelled_queue_drain_is_not_double_counted():
    """取消清队列的丢弃已体现在 finished_n − played，不额外计入 dropped / queue_dropped。"""
    rt, emitted = make_runtime()
    start_speaking(rt)
    rt.handle_bridge_event({"ev": "tts_chunk_started", "index": 0})
    rt.handle_bridge_event({"ev": "tts_chunk_finished", "index": 0})
    rt.handle_bridge_event({"ev": "tts_chunk_dropped", "index": 1, "reason": "cancelled"})

    rt.abort_speaking(reason="user_cancel")

    cancelled = [p for t, p in emitted if t == "speech.tts_cancelled"][-1]
    assert cancelled["played"] == 1
    assert "dropped" not in cancelled
    assert "queue_dropped" not in cancelled


# ---------------------------------------------------------------- 门限来自配置（GH-6 D2）
def test_state_defaults_echo_the_unmodified_thresholds():
    rt, _emitted = make_runtime()

    state = rt.state()

    assert state["barge_in_erle_margin_db"] == 15.0
    assert state["barge_in_erle_floor_db"] == 20.0
    assert state["barge_in_erle_overridden"] == []


def test_configured_floor_controls_erle_usability():
    """底线来自配置：低于生效底线 → no_erle（缺证据方向不变）。"""
    rt, emitted = make_runtime(barge_in_erle_floor_db=25.0)
    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt, erle=22.0)  # 新鲜，但低于配置的 25 dB 底线

    vad_rise(rt, db=-5.0)

    gate = gates(emitted)[-1]
    assert gate["reason"] == "no_erle"
    assert rt.response is not None


def test_state_echo_matches_the_threshold_the_gate_uses():
    """本轮判据 2：``/v1/audio/state`` 回显的值必须就是判定用的值，不许只回显不生效。"""
    rt, emitted = make_runtime(
        barge_in_erle_margin_db=30.0,
        barge_in_erle_floor_db=22.0,
        barge_in_erle_overridden=("margin", "floor"),
    )
    state = rt.state()
    assert state["barge_in_erle_margin_db"] == 30.0
    assert state["barge_in_erle_floor_db"] == 22.0
    assert state["barge_in_erle_overridden"] == ["margin", "floor"]

    calibrate(rt)
    start_speaking(rt)
    probe_erle(rt, erle=32.0)
    vad_rise(rt, db=-12.0)  # 低于 ambient(-40) + margin(30) = -10

    gate = gates(emitted)[-1]
    assert gate["decision"] == "suppressed"
    assert gate["reason"] == "echo"
    assert gate["threshold_db"] == AMBIENT_DB + state["barge_in_erle_margin_db"]
    assert gate["threshold_db"] == rt.speech_db_barge_in
    assert rt.response is not None

    # 同一配置下越过门限就该真的打断（回显不是装饰）。
    rt.handle_bridge_event({"ev": "final", "utterance_id": "utt-auto-1", "text": "", "no_speech": True})
    vad_rise(rt, utterance_id="utt-auto-2", db=-5.0)
    assert gates(emitted)[-1]["decision"] == "pass"
    assert [p for t, p in emitted if t == "speech.tts_cancelled"][-1]["reason"] == "barge_in"


# ---------------------------------------------------------------- 被丢弃的轮次要有分母（GH-7）
def test_busy_new_utterance_emits_speech_ignored():
    """显式 listen 撞上未结束的轮次：拒绝，但必须留下 speech.ignored{busy}。

    否则用户在时间线上只看到「我说了，机器没反应」，robotd 侧没有分母。
    """
    rt, emitted = make_runtime()
    first = rt.new_utterance(task_id="t-first")

    with pytest.raises(RuntimeError, match="上一轮听还没结束"):
        rt.new_utterance(task_id="t-second")

    ignored = [p for t, p in emitted if t == "speech.ignored"]
    assert len(ignored) == 1
    assert ignored[0]["reason"] == "busy"
    # 身份指向**被丢弃的那次请求**，不是已经在听的那一轮。
    assert ignored[0]["utterance_id"] != first.utterance_id
    assert ignored[0]["utterance_id"].startswith("utt-")
    assert rt.utt is first


def test_rejected_late_auto_utterance_emits_speech_ignored():
    """桥在另一轮进行中送来新自动轮：不认领，但要记下这一轮被丢了。"""
    rt, emitted = make_runtime()
    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-1"})

    rt.handle_bridge_event({"ev": "ready", "utterance_id": "utt-auto-2"})

    assert rt.utt is not None and rt.utt.utterance_id == "utt-auto-1"
    ignored = [p for t, p in emitted if t == "speech.ignored"]
    assert ignored == [{"utterance_id": "utt-auto-2", "reason": "busy"}]

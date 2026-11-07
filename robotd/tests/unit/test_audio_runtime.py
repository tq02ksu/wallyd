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


def make_runtime() -> tuple[AudioRuntime, list[tuple[str, dict]]]:
    emitted: list[tuple[str, dict]] = []
    rt = AudioRuntime(emit=lambda t, p: emitted.append((t, p)))
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

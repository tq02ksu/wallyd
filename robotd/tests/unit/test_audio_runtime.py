"""语音运行时的纪律测试（R14）。

只测**不依赖真麦克风**的部分：静音守门与 utterance 生命周期。真实链路
（桥、TCC、VAD、ASR）的验证在 ``eval/r14-voice-bringup-2026-10-24.md``。

保留这些用例的理由：静音守门曾经漏掉显式 ``speech/listen``，实测静音后仍产生
识别文本，违反了 R14「静音期间不产生新的识别结果」。那是**没有测试盯着**才活下来的缺陷。
"""

from __future__ import annotations

import pytest

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

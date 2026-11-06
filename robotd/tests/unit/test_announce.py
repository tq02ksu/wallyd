"""系统播报（robot_announce）的单元测试：不绑 socket、不碰真实麦克风/扬声器。

HTTP 集成测试在受限沙箱里无法创建监听 socket（Operation not permitted），
所以这里直接调用传输层处理函数，验证同一条路径的校验、事件与 stop 语义。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from robotd.api.http import RouteContext, _h_announce
from robotd.app import App
from robotd.config import Config
from robotd.core.errors import ErrorCode, RobotdError
from robotd.core.types import DeviceStatus


class FakeAudioBridge:
    def __init__(self) -> None:
        self.status = DeviceStatus.READY
        self.sent: list[dict] = []

    def ready(self) -> bool:
        return True

    def send(self, cmd: dict, best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)


def make_app(*, with_bridge: bool = True) -> tuple[App, FakeAudioBridge | None]:
    work = Path(__file__).resolve().parents[2] / "work" / "pytest-announce"
    work.mkdir(parents=True, exist_ok=True)
    app = App(Config(sim=True, http_port=0, work_dir=str(work)))
    bridge = None
    if with_bridge:
        bridge = FakeAudioBridge()
        app.audio.attach(bridge)
    return app, bridge


def ctx(app: App, body: dict) -> RouteContext:
    return RouteContext(
        app=app,
        method="POST",
        path="/v1/robot/announce",
        query={},
        params={},
        body=body,
        handler=None,  # type: ignore[arg-type]
    )


def valid_body(**overrides) -> dict:
    body = {
        "approval_id": "appr-1",
        "kind": "approval_repeat",
        "action_label": "向前跟随",
        "args_summary": "目标：穿红衣服的人",
    }
    body.update(overrides)
    return body


def test_announce_accepts_structured_request_and_returns_rendered_text():
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, valid_body()))
    assert result["status"] == "accepted"
    assert result["approval_id"] == "appr-1"
    assert result["kind"] == "approval_repeat"
    assert "向前跟随" in result["text"]
    assert "确认" in result["text"]
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"]
    assert len(speak) == 1
    assert speak[0]["text"] == result["text"]


@pytest.mark.parametrize(
    "body",
    [
        {"text": "任意自由文本"},
        valid_body(text="夹带自由文本"),
        valid_body(kind="free_speech"),
        valid_body(action_label=""),
        valid_body(args_summary="x" * 201),
    ],
)
def test_announce_rejects_free_text_and_unknown_shapes(body):
    app, _ = make_app()
    with pytest.raises(RobotdError) as exc:
        _h_announce(ctx(app, body))
    assert exc.value.code is ErrorCode.VALIDATION


def test_announce_without_bridge_fails_loudly_with_event():
    app, _ = make_app(with_bridge=False)
    with pytest.raises(RobotdError) as exc:
        _h_announce(ctx(app, valid_body()))
    assert exc.value.code is ErrorCode.UNAVAILABLE
    failed = [e for e in app.kernel.recent_events(20) if e.type == "speech.announce_failed"]
    assert len(failed) == 1
    assert failed[0].payload["approval_id"] == "appr-1"
    assert failed[0].payload["kind"] == "approval_repeat"
    assert failed[0].payload["task_id"]


def test_stop_interrupts_announcement_and_cancels_task():
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, valid_body()))
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"][-1]

    app.request_stop(reason="user")

    assert any(c.get("cmd") == "stop_speak" for c in bridge.sent)
    cancelled = [e for e in app.kernel.recent_events(30) if e.type == "speech.tts_cancelled"]
    assert cancelled
    assert cancelled[-1].payload["response_id"] == speak["response_id"]
    assert cancelled[-1].payload["approval_id"] == "appr-1"
    assert cancelled[-1].payload["reason"] == "stop"
    assert app.kernel.get_task(result["task_id"]).state.value == "cancelled"


def test_announce_completion_event_only_after_bridge_finishes():
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, valid_body()))
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"][-1]

    assert not [e for e in app.kernel.recent_events(30) if e.type == "speech.tts_finished"]

    app.audio.handle_bridge_event(
        {"ev": "tts_finished", "response_id": speak["response_id"], "chunks": 1, "played": 1}
    )
    finished = [e for e in app.kernel.recent_events(30) if e.type == "speech.tts_finished"]
    assert len(finished) == 1
    assert finished[0].payload["approval_id"] == "appr-1"
    assert finished[0].payload["kind"] == "approval_repeat"
    assert finished[0].payload["task_id"] == result["task_id"]

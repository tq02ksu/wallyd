"""``POST /v1/speech/abort`` 的路由语义（GH-6）。

集成测试会起真实回环 socket；受限沙箱里 AF_INET 建 socket 会被拒绝，所以这里直接
调用处理函数，把「无活动播报也 200 / 幂等 / reason=user_cancel」钉在传输层之上、
能力门之内。真实 HTTP 形状仍由 ``tests/integration/test_api_http.py`` 覆盖。
"""

from __future__ import annotations

from robotd.api.http import RouteContext, _h_speech_abort
from robotd.app import App
from robotd.config import Config
from robotd.core.types import DeviceStatus


class FakeBridge:
    def __init__(self) -> None:
        self.status = DeviceStatus.READY
        self.sent: list[dict] = []

    def ready(self) -> bool:
        return True

    def send(self, cmd: dict, best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)


def make_app(tmp_path) -> App:
    app = App(Config(sim=True, http_port=0, work_dir=str(tmp_path)))
    app.audio.attach(FakeBridge())
    return app


def call(app: App, body: dict) -> dict:
    ctx = RouteContext(
        app=app,
        method="POST",
        path="/v1/speech/abort",
        query={},
        params={},
        body=body,
        handler=None,  # type: ignore[arg-type]
    )
    return _h_speech_abort(ctx)


def test_speech_abort_without_active_playback_is_200_and_idempotent(tmp_path):
    app = make_app(tmp_path)

    first = call(app, {})
    second = call(app, {})

    assert first["status"] == "accepted" and second["status"] == "accepted"
    assert app.kernel.get_task(first["task_id"]).state.value == "completed"
    assert app.kernel.get_task(second["task_id"]).state.value == "completed"
    # 没有播报对象就不许伪造 speech.tts_cancelled。
    assert not [e for e in app.kernel.recent_events(20) if e.type == "speech.tts_cancelled"]


def test_speech_abort_emits_user_cancel_for_active_response(tmp_path):
    app = make_app(tmp_path)
    resp = app.audio.new_response(task_id="t-1")
    app.audio.handle_bridge_event({"ev": "tts_started", "chunks": 2})
    app.audio.handle_bridge_event({"ev": "tts_chunk_started", "index": 0})
    app.audio.handle_bridge_event({"ev": "tts_chunk_finished", "index": 0})

    out = call(app, {"response_id": resp.response_id})

    assert out["status"] == "accepted"
    cancelled = [e for e in app.kernel.recent_events(30) if e.type == "speech.tts_cancelled"]
    assert len(cancelled) == 1
    assert cancelled[0].payload["reason"] == "user_cancel"
    assert cancelled[0].payload["played"] == 1
    assert app.audio.response is None


def test_speech_abort_does_not_stop_a_different_response(tmp_path):
    """给了不匹配的 response_id 时只受理、不误伤当前播报，也不伪造终态事件。"""
    app = make_app(tmp_path)
    resp = app.audio.new_response(task_id="t-1")
    app.audio.handle_bridge_event({"ev": "tts_started", "chunks": 2})

    out = call(app, {"response_id": "tts-other"})

    assert out["status"] == "accepted"
    assert app.audio.response is resp
    assert not [e for e in app.kernel.recent_events(20) if e.type == "speech.tts_cancelled"]

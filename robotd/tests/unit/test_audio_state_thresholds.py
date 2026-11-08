"""`GET /v1/audio/state` 回显的打断门限必须就是判定用的那一份（GH-6 D2 / 判据 2）。

集成测试会起真实回环 socket；受限沙箱里 AF_INET 建 socket 会被拒绝，所以这里直接
调用处理函数，把「配置文件 → Config → App → AudioRuntime → speech.gate」整条链
钉在传输层之上。真实 HTTP 形状仍由 ``tests/integration/test_api_http.py`` 覆盖。
"""

from __future__ import annotations

import json

from robotd.api.http import RouteContext, _h_audio_state
from robotd.app import App
from robotd.config import Config, from_file
from robotd.core.types import DeviceStatus


class FakeBridge:
    def __init__(self) -> None:
        self.status = DeviceStatus.READY
        self.sent: list[dict] = []

    def ready(self) -> bool:
        return True

    def send(self, cmd: dict, best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)


def make_app(tmp_path, **overrides) -> App:
    if overrides:
        path = tmp_path / "robotd.json"
        path.write_text(json.dumps(overrides), encoding="utf-8")
        config = from_file(str(path))
    else:
        config = Config()
    app = App(config.with_overrides(sim=True, http_port=0, work_dir=str(tmp_path)))
    app.audio.attach(FakeBridge())
    return app


def read_state(app: App) -> dict:
    ctx = RouteContext(
        app=app,
        method="GET",
        path="/v1/audio/state",
        query={},
        params={},
        body=None,
        handler=None,  # type: ignore[arg-type]
    )
    return _h_audio_state(ctx)


def test_config_file_values_are_echoed_by_audio_state(tmp_path):
    """判据 2：配置文件写 30，``GET /v1/audio/state`` 就回显 30。"""
    app = make_app(tmp_path, barge_in_erle_margin_db=30, barge_in_erle_floor_db=22)

    state = read_state(app)

    assert state["barge_in_erle_margin_db"] == 30.0
    assert state["barge_in_erle_floor_db"] == 22.0
    assert state["barge_in_erle_overridden"] == ["margin", "floor"]


def test_echoed_margin_is_the_value_used_by_the_gate_formula(tmp_path):
    """同一份配置：回显 30，``speech.gate.threshold_db`` 也必须是 ambient + 30。"""
    app = make_app(tmp_path, barge_in_erle_margin_db=30)
    state = read_state(app)

    app.audio.handle_bridge_event(
        {"ev": "vad_calibrated", "ambient_db": -40.0, "speech_db": -32.0, "silence_db": -38.0}
    )
    app.audio.handle_bridge_event({"ev": "aec_echo_probe", "aec_erle_db": 32.0, "render_db": -10.0})
    app.audio.handle_bridge_event(
        {"ev": "speech_state", "state": "speech", "utterance_id": "utt-1", "rms_db": -12.0}
    )

    gates = [e.payload for e in app.kernel.recent_events(40) if e.type == "speech.gate"]
    margin = state["barge_in_erle_margin_db"]
    assert margin == 30.0
    # 门限 = max(ambient + margin, speech_db) = max(-10, -32) = -10。
    assert gates[-1]["threshold_db"] == -10.0
    assert gates[-1]["threshold_db"] == -40.0 + margin
    assert app.audio.speech_db_barge_in == gates[-1]["threshold_db"]


def test_defaults_are_echoed_without_overrides(tmp_path):
    app = make_app(tmp_path)

    state = read_state(app)

    assert state["barge_in_erle_margin_db"] == 15.0
    assert state["barge_in_erle_floor_db"] == 20.0
    assert state["barge_in_erle_overridden"] == []

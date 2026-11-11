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


class FailingSpeakBridge(FakeAudioBridge):
    """发包失败，但停止指令仍能送达：验证失败路径会主动停住已发出的播报。"""

    def send(self, cmd: dict, best_effort: bool = False) -> None:  # noqa: FBT001, FBT002
        self.sent.append(cmd)
        if cmd.get("cmd") == "speak":
            raise RuntimeError("桥写入失败")


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


def clarification_body(**overrides) -> dict:
    body = {
        "kind": "clarification",
        "reason": "missing_arguments",
        "action_label": "走到我这儿来",
        "missing": ["target_track_id"],
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
    assert "请说确认" in result["text"], "复述与确认之间必须有可闻的固定尾缀"
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"]
    assert len(speak) == 1
    assert speak[0]["text"] == result["text"]


@pytest.mark.parametrize(
    "body",
    [
        {"text": "任意自由文本"},
        valid_body(text="夹带自由文本"),
        valid_body(kind="approval_unheard", text="夹带自由文本"),
        valid_body(kind="free_speech"),
        valid_body(action_label=""),
        valid_body(args_summary="x" * 61),
        # GH-53：含糊词/未按词表读法的数字/科学计数法必须在契约层被拒绝，
        # 不能交给 TTS 去「随机读」。
        valid_body(args_summary="走一点点"),
        valid_body(args_summary="大约二米"),
        valid_body(args_summary="左右"),
        valid_body(args_summary="0.15 米每秒"),
        valid_body(args_summary="2.0 米"),
        valid_body(args_summary="1e-3 米"),
        valid_body(args_summary="速度二 m/s"),
    ],
)
def test_announce_rejects_free_text_and_unknown_shapes(body):
    app, _ = make_app()
    with pytest.raises(RobotdError) as exc:
        _h_announce(ctx(app, body))
    assert exc.value.code is ErrorCode.VALIDATION
    # 判据 2 要的是 HTTP 400，不只是内部错误码；这里不绑 socket 也能证明映射。
    # 真实 HTTP 传输由 CI 的集成 lane 覆盖，受限沙箱不能监听回环端口。
    assert exc.value.http_status == 400
    assert exc.value.to_public()["error"]["code"] == "E_VALIDATION"


def test_announce_accepts_lexicon_number_reading():
    """数字必须先变成词表里的中文读法；robotd 与 agentd 读同一份词表。"""
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, valid_body(args_summary="速度零点一五米每秒，最远距离二米")))
    assert "速度零点一五米每秒" in result["text"]
    assert "请说确认" in result["text"]


def test_announce_unheard_uses_fixed_template_without_free_text():
    """复述次数用尽：robotd 念固定收尾句，仍不接受自由文本。"""
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, valid_body(kind="approval_unheard", args_summary="最远距离二米")))
    assert result["kind"] == "approval_unheard"
    assert result["text"] == "我没有听清，这次没有执行。"
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"]
    assert speak and speak[0]["text"] == result["text"]


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


def test_announce_failure_after_send_stops_bridge_and_clears_response():
    app, _ = make_app(with_bridge=False)
    bridge = FailingSpeakBridge()
    app.audio.attach(bridge)
    with pytest.raises(RobotdError) as exc:
        _h_announce(ctx(app, valid_body()))
    assert exc.value.code is ErrorCode.UNAVAILABLE
    assert any(c.get("cmd") == "stop_speak" for c in bridge.sent)
    assert app.audio.response is None, "失败后不能留下 speaking 状态"
    failed = [e for e in app.kernel.recent_events(20) if e.type == "speech.announce_failed"]
    assert len(failed) == 1


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


def test_announce_clarification_renders_structured_question_and_speaks():
    """GH-49 判据 1：追问必须真的进入播报链路，且正文来自结构化字段。"""
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, clarification_body()))

    assert result["status"] == "accepted"
    assert result["kind"] == "clarification"
    assert "approval_id" not in result, "澄清没有审批记录"
    assert "走到我这儿来" in result["text"]
    assert "目标" in result["text"], "missing 里的字段名要渲染成可念的追问"
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"]
    assert len(speak) == 1
    assert speak[0]["text"] == result["text"]


def test_announce_clarification_renders_candidates_and_more():
    """GH-49 判据 4：歧义要念出候选；超过 3 条只念前两条 +「还是别的」。"""
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(
        ctx(
            app,
            clarification_body(
                reason="ambiguous",
                action_label=None,
                missing=None,
                candidates=["走到我这儿来", "跟随我"],
                more=True,
            ),
        )
    )
    assert "走到我这儿来" in result["text"]
    assert "跟随我" in result["text"]
    assert "还是别的" in result["text"]


@pytest.mark.parametrize(
    "body",
    [
        clarification_body(text="任意自由文本"),
        clarification_body(reason="free_speech"),
        clarification_body(approval_id="appr-1"),
        clarification_body(args_summary="审批字段不能混进澄清"),
        clarification_body(missing=["用户 原话"]),
        clarification_body(missing=["a"] * 9),
        clarification_body(reason="ambiguous", candidates=["a", "b", "c", "d"]),
        clarification_body(reason="ambiguous", candidates=["a" * 81]),
    ],
)
def test_announce_clarification_rejects_free_text_and_wrong_shapes(body):
    app, _ = make_app()
    with pytest.raises(RobotdError) as exc:
        _h_announce(ctx(app, body))
    assert exc.value.code is ErrorCode.VALIDATION


def test_announce_clarification_without_bridge_fails_without_approval_id():
    app, _ = make_app(with_bridge=False)
    with pytest.raises(RobotdError) as exc:
        _h_announce(ctx(app, clarification_body()))
    assert exc.value.code is ErrorCode.UNAVAILABLE
    failed = [e for e in app.kernel.recent_events(20) if e.type == "speech.announce_failed"]
    assert len(failed) == 1
    assert failed[0].payload["kind"] == "clarification"
    assert "approval_id" not in failed[0].payload


def test_announce_clarification_completion_has_no_approval_id():
    app, bridge = make_app()
    assert bridge is not None
    result = _h_announce(ctx(app, clarification_body()))
    speak = [c for c in bridge.sent if c.get("cmd") == "speak"][-1]

    app.audio.handle_bridge_event(
        {"ev": "tts_finished", "response_id": speak["response_id"], "chunks": 1, "played": 1}
    )
    finished = [e for e in app.kernel.recent_events(30) if e.type == "speech.tts_finished"]
    assert len(finished) == 1
    assert finished[0].payload["kind"] == "clarification"
    assert "approval_id" not in finished[0].payload
    assert finished[0].payload["task_id"] == result["task_id"]

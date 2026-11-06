"""契约一致性测试（R03 门禁的另一半）。

`npm run contract:check` 保证「生成物 == 契约」；这里保证「Python 实现 == 契约」。
两者缺一，契约就会漂移。

读的是 ``contracts/generated/*.json``（生成物，已由 check.mjs 证明与源一致），
所以本测试不依赖 PyYAML，也不需要在 CI 里跑 Node。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from robotd.capabilities import Implementation, Registry
from robotd.core.errors import ErrorCode, RobotdError, http_status_for
from robotd.core.types import TaskState

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def load(name: str) -> dict:
    path = CONTRACTS / "generated" / name
    assert path.exists(), f"缺生成物 {path}；先跑 npm run contract:generate"
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def spec() -> dict:
    return load("openapi.json")


@pytest.fixture(scope="module")
def tools() -> list[dict]:
    return load("mcp-tools.json")


@pytest.fixture(scope="module")
def events() -> dict:
    return load("robotd-events.json")


# ---------------------------------------------------------------- 错误码
def test_every_error_code_in_contract_is_known_to_implementation(spec):
    declared = set((spec.get("x-robotd-errors") or {}).keys())
    implemented = {code.value for code in ErrorCode}
    missing = declared - implemented
    assert not missing, f"契约声明了实现不认识的错误码：{sorted(missing)}"


def test_every_implementation_error_code_is_declared(spec):
    declared = set((spec.get("x-robotd-errors") or {}).keys())
    extra = {code.value for code in ErrorCode} - declared
    assert not extra, f"实现引入了契约没声明的错误码：{sorted(extra)}"


def test_http_status_mapping_is_not_all_400():
    """旧 POC 把未分类异常一律映射 400，把内部故障伪装成请求错误。"""
    assert http_status_for(ErrorCode.BUSY) == 409
    assert http_status_for(ErrorCode.NO_TASK) == 404
    assert http_status_for(ErrorCode.INTERNAL) == 500
    assert http_status_for(ErrorCode.UNAVAILABLE) == 503
    assert http_status_for(ErrorCode.TIMEOUT) == 504
    assert http_status_for("E_NOT_A_REAL_CODE") == 500


def test_error_body_matches_contract_shape():
    body = RobotdError(ErrorCode.BUSY, "忙").to_public()
    assert body["ok"] is False
    assert set(body["error"]) >= {"code", "message"}
    assert body["error"]["code"] == "E_BUSY"


# ---------------------------------------------------------------- 操作面
def test_mcp_tool_face_matches_contract_tools(tools):
    """MCP 工具面由契约投影，不由内部能力表决定。"""
    registry = Registry()
    public_names = {cap.public_name for cap in registry.all() if cap.public_name}
    # 系统路径（robot_announce）也在能力表里，但显式排除出 Agent 工具面。
    assert public_names - {"events_subscribe", "robot_announce"} == {tool["name"] for tool in tools}
    # debug 与 websocket 必须被排除
    names = {t["name"] for t in tools}
    assert "debug_serial" not in names
    assert "events_subscribe" not in names
    assert "robot_announce" not in names
    assert len(tools) == 14, f"MCP 工具面必须保持 14 项，实际 {len(tools)}"


def test_robot_announce_is_contract_declared_system_path(spec, tools):
    """审批复述必须有一条契约可见、免审批、且不在 Agent 工具面的路径。"""
    operation = spec["paths"]["/v1/robot/announce"]["post"]
    assert operation["operationId"] == "robot_announce"
    assert operation.get("x-requires-approval") is not True
    assert operation.get("x-mcp-exclude") is True
    assert "robot_announce" not in {t["name"] for t in tools}

    speak = next(t for t in tools if t["name"] == "robot_speak")
    assert speak["requiresApproval"] is True
    assert "text" in speak["inputSchema"]["properties"]

    announce_body = operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    schema = spec["components"]["schemas"][announce_body.rsplit("/", 1)[-1]]
    assert "text" not in schema["properties"], "系统播报不得接受任意自由文本"
    assert schema.get("additionalProperties") is False


def test_no_hardware_primitives_in_public_tools(tools):
    banned = ("estop", "gpio", "pin", "pwm", "serial", "ena_set", "motor_set")
    for tool in tools:
        for word in banned:
            assert word not in tool["name"], f"公开工具 {tool['name']} 含硬件原语 {word}"


def test_approval_flags_in_contract_are_reflected_in_capabilities(spec):
    registry = Registry()
    for item in spec["paths"].values():
        for method in ("get", "post", "put", "delete", "patch"):
            operation = item.get(method)
            if not operation or "debug" in operation.get("tags", []):
                continue
            cap = registry.by_public_name(operation["operationId"])
            assert cap.requires_approval is operation.get("x-requires-approval", False)


def test_task_state_enum_matches_implementation(spec):
    declared = set(spec["components"]["schemas"]["TaskState"]["enum"])
    assert declared == {s.value for s in TaskState}


# ---------------------------------------------------------------- 状态与事件
def test_state_required_fields_are_all_produced(spec):
    required = set(spec["components"]["schemas"]["RobotState"]["required"])
    from robotd.core.state import RobotStateStore

    produced = set(RobotStateStore(robot_id="x", transport="sim").snapshot())
    assert required <= produced, f"实现少产出：{sorted(required - produced)}"


def test_snapshot_event_seq_present(spec):
    assert "event_seq" in spec["components"]["schemas"]["RobotState"]["required"]


def test_registered_events_have_required_payload_fields(events):
    for ev in events["events"]:
        assert ev["type"], ev
        assert isinstance(ev["payload_fields"], list), ev["type"]


def test_events_never_carry_internal_clock(events):
    banned = set(events["envelope"]["forbidden_payload_keys"])
    for ev in events["events"]:
        assert not (banned & set(ev["payload_fields"])), f"{ev['type']} 含内部字段"


def test_board_raw_events_are_excluded_from_public(events):
    public = {ev["type"] for ev in events["events"]}
    assert not {t for t in public if t.startswith("board.")}
    excluded = {ev["type"] for ev in events["excluded_from_public"]}
    assert "board.log" in excluded


def test_vision_events_are_marked_unimplemented(events):
    """vision/camera/people 是计划能力，现在不能伪装成已实现。"""
    reserved = {ev["type"] for ev in events["reserved_unimplemented"]}
    assert any(t.startswith("vision") for t in reserved)
    assert any(t.startswith("people") for t in reserved)


def test_unimplemented_capabilities_state_a_reason():
    for cap in Registry().all():
        if cap.implementation is Implementation.UNIMPLEMENTED:
            assert cap.unavailable_reason, f"{cap.name} 标了未实现却没写原因"


def test_servers_are_loopback_only(spec):
    for server in spec.get("servers", []):
        assert "0.0.0.0" not in server["url"]

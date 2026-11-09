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

from robotd.api.http import build_routes
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
    # GH-6 新增 speech_abort：工具面从 14 增到 15。数量是契约的一部分，
    # 增删端点必须同时改这里，否则「契约悄悄多了一条路」不会被发现。
    assert len(tools) == 15, f"MCP 工具面必须保持 15 项，实际 {len(tools)}"


def test_robot_announce_is_contract_declared_system_path(spec, tools):
    """审批复述必须有一条契约可见、免审批、且不在 Agent 工具面的路径。"""
    operation = spec["paths"]["/v1/robot/announce"]["post"]
    assert operation["operationId"] == "robot_announce"
    assert operation.get("x-requires-approval") in (None, False)
    assert operation.get("x-mcp-exclude") is True
    assert "robot_announce" not in {t["name"] for t in tools}

    speak = next(t for t in tools if t["name"] == "robot_speak")
    assert speak["approvalParams"] is not None
    assert "text" in speak["approvalParams"]
    assert "text" in speak["inputSchema"]["properties"]

    announce_body = operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    schema = spec["components"]["schemas"][announce_body.rsplit("/", 1)[-1]]
    variants = schema["oneOf"]
    by_kind = {}
    for ref in variants:
        name = ref["$ref"].rsplit("/", 1)[-1]
        variant = spec["components"]["schemas"][name]
        assert "text" not in variant["properties"], "系统播报不得接受任意自由文本"
        assert variant.get("additionalProperties") is False
        kinds = variant["properties"]["kind"]["enum"]
        assert len(kinds) == 1
        by_kind[kinds[0]] = variant
    assert set(by_kind) == {"approval_repeat", "clarification"}
    assert {"approval_id", "action_label", "args_summary"} <= set(by_kind["approval_repeat"]["required"])
    assert "approval_id" not in by_kind["clarification"]["required"]
    assert "reason" in by_kind["clarification"]["required"]


def test_no_hardware_primitives_in_public_tools(tools):
    banned = ("estop", "gpio", "pin", "pwm", "serial", "ena_set", "motor_set")
    for tool in tools:
        for word in banned:
            assert word not in tool["name"], f"公开工具 {tool['name']} 含硬件原语 {word}"


def _approval_params(operation: dict) -> list[str] | None:
    """契约里 ``x-requires-approval`` 的对象形态；不存在返回 None。"""
    raw = operation.get("x-requires-approval")
    if raw is None or raw is False:
        return None
    assert isinstance(raw, dict), (
        f"{operation.get('operationId')} 的 x-requires-approval 必须是对象 {{ params: [...] }}，"
        f"实际 {type(raw).__name__}"
    )
    assert set(raw) == {"params"}, f"{operation.get('operationId')} 的 x-requires-approval 只允许 params"
    params = raw["params"]
    assert isinstance(params, list) and all(isinstance(p, str) and p for p in params)
    return params


def test_contract_owner_declares_no_boolean_approval_flag(spec):
    """本仓库的 3 个审批端点必须全部是对象形态，0 处残留布尔 true。"""
    boolean_form = [
        op["operationId"]
        for item in spec["paths"].values()
        for op in item.values()
        if isinstance(op, dict) and op.get("x-requires-approval") is True
    ]
    assert not boolean_form, f"仍有端点使用布尔形态 x-requires-approval: true：{boolean_form}"


def test_approval_flags_in_contract_are_reflected_in_capabilities(spec):
    registry = Registry()
    for item in spec["paths"].values():
        for method in ("get", "post", "put", "delete", "patch"):
            operation = item.get(method)
            if not operation or "debug" in operation.get("tags", []):
                continue
            cap = registry.by_public_name(operation["operationId"])
            params = _approval_params(operation)
            assert cap.requires_approval is (params is not None), (
                f"{operation['operationId']} 的 Capability.requires_approval 与契约不一致"
            )
            assert list(cap.approval_params) == (params or []), (
                f"{operation['operationId']} 的 Capability.approval_params 与契约 params 不一致"
            )


def test_approval_params_cover_speak_follow_and_calibration(spec):
    """验收判据 1：三个物理/发声端点必须声明“必须被听见并绑定”的字段。"""
    declared = {
        op["operationId"]: _approval_params(op)
        for item in spec["paths"].values()
        for op in item.values()
        if isinstance(op, dict) and op.get("operationId")
    }
    # 精确匹配：多绑一个「怎么念 / 怎么存 / 开多快」的字段，就会让无关改动
    # 也要求重新审批；少绑一个字段则会漏绑用户听见的内容。
    assert declared["robot_speak"] == ["text"]
    assert declared["robot_follow"] == ["target_track_id", "target"]
    assert declared["robot_calibration_set"] == ["steps_per_m", "wheelbase_mm"]


def test_approval_params_reference_real_request_body_fields(spec, tools):
    """一致性门禁：声明的字段必须真的存在于该端点的 requestBody schema 里。

    字段改名（schema 改了、审批声明没改，或反之）两边都必须红，否则用户听见的
    参数名与 robotd 实际接收的参数名可以悄悄分叉。
    """
    by_name = {tool["name"]: tool for tool in tools}
    for item in spec["paths"].values():
        for operation in item.values():
            if not isinstance(operation, dict) or not operation.get("operationId"):
                continue
            params = _approval_params(operation)
            if params is None:
                continue
            body = (
                operation.get("requestBody", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema", {})
            )
            ref = body.get("$ref")
            assert ref, f"{operation['operationId']} 有 approvalParams 却没有 JSON requestBody schema"
            schema = spec["components"]["schemas"][ref.rsplit("/", 1)[-1]]
            unknown = [p for p in params if p not in schema.get("properties", {})]
            assert not unknown, (
                f"{operation['operationId']} 的 approvalParams 不在 requestBody schema 里：{unknown}"
            )
            tool = by_name[operation["operationId"]]
            assert tool["approvalParams"] == params, (
                f"mcp-tools.json 的 {operation['operationId']}.approvalParams 与契约不一致"
            )


def test_generated_tools_use_approval_params_only(tools):
    """生成物只能有 approvalParams：存在即需审批，[] 表示需审批但无参数可绑。"""
    approval_tools = {t["name"] for t in tools if "approvalParams" in t}
    assert approval_tools == {"robot_follow", "robot_speak", "robot_calibration_set"}
    for tool in tools:
        assert "requiresApproval" not in tool, f"{tool['name']} 仍生成 requiresApproval 布尔"
        if "approvalParams" in tool:
            assert isinstance(tool["approvalParams"], list)


def test_approval_flags_in_contract_are_reflected_in_routes(spec):
    """契约的审批声明必须落到**路由表**上，而不是只落在能力注册表里。

    审批门（ISSUE-B / #18）读的是 ``Route.requires_approval``：如果某条路由把
    ``robot_announce`` 误标成需审批，审批复述就会重新变成「审批里再审批」；
    反过来把 ``robot_speak`` 标成免审批，等于给任意调用方开一个后门。
    直接比对 ``build_routes()``，不依赖起监听 socket，也不会因为能力表被改而漏检。
    """
    declared: dict[str, bool] = {}
    for item in spec["paths"].values():
        for method in ("get", "post", "put", "delete", "patch"):
            operation = item.get(method)
            if not operation or "debug" in operation.get("tags", []):
                continue
            declared[operation["operationId"]] = _approval_params(operation) is not None

    routed = {r.operation_id: r.requires_approval for r in build_routes(debug=False)}
    assert routed.keys() == (declared.keys() - {"events_subscribe"})
    mismatched = {
        op: (routed[op], flag) for op, flag in declared.items() if op in routed and routed[op] is not flag
    }
    assert not mismatched, f"路由的 requires_approval 与契约不一致：{mismatched}"

    announce = next(r for r in build_routes(debug=False) if r.operation_id == "robot_announce")
    assert announce.method == "POST"
    assert announce.template == "/v1/robot/announce"
    assert announce.requires_approval is False


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


def test_state_rejected_event_is_registered_without_payload_values(events):
    """state.rejected 只能说明「哪条字段被拒、为什么」，不得携带 payload 原文。"""
    registered = {ev["type"]: ev for ev in events["events"]}
    rejected = registered["state.rejected"]
    assert set(rejected["payload_fields"]) == {"type", "payload_keys", "reason"}
    assert set(rejected["required_fields"]) == {"type", "payload_keys", "reason"}


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

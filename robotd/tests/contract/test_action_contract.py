"""GH-85 契约门禁：submitTask(move_distance)、ActionEpisode、TaskResult。

读的是 ``contracts/generated/*.json``（已由 ``npm run contract:check`` 证明与源一致），
所以本测试不依赖 PyYAML，也不在 CI 里跑 Node。

Node 侧 ``contracts/tools/task-contract.test.mjs`` 用 openapi-backend 校验实例；
这里补「Python 实现 == 契约」：路由/能力/未实现语义，以及两侧都读同一份策略。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from robotd.api.http import RouteContext, _h_task_submit, build_routes
from robotd.capabilities import Implementation, Registry
from robotd.core.errors import ErrorCode, RobotdError

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def load(name: str) -> dict:
    path = CONTRACTS / "generated" / name
    assert path.exists(), f"缺生成物 {path}；先跑 npm run contract:generate"
    return json.loads(path.read_text(encoding="utf-8"))


def load_source() -> dict:
    return json.loads((CONTRACTS / "events.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def spec() -> dict:
    return load("openapi.json")


@pytest.fixture(scope="module")
def events() -> dict:
    return load("robotd-events.json")


@pytest.fixture(scope="module")
def tools() -> list[dict]:
    return load("mcp-tools.json")


def schema_of(spec: dict, node: dict) -> dict:
    ref = node.get("$ref")
    if ref:
        return spec["components"]["schemas"][ref.rsplit("/", 1)[-1]]
    return node


class _FakeApp:
    def __init__(self) -> None:
        self.registry = Registry()


def _ctx(body: dict) -> RouteContext:
    return RouteContext(
        app=_FakeApp(),  # type: ignore[arg-type]
        method="POST",
        path="/v1/tasks",
        query={},
        params={},
        body=body,
        handler=None,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------- 操作面
def test_submit_operation_is_declared_and_curated(spec):
    operation = spec["paths"]["/v1/tasks"]["post"]
    assert operation["operationId"] == "task_submit"
    # 实现前不进 Codex 工具面：契约必须显式排除，而不是靠调用方自觉。
    assert operation.get("x-mcp-exclude") is True
    assert operation.get("x-requires-approval") in (None, False)
    body_ref = operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    assert body_ref.endswith("/TaskSubmitRequest")
    ok_ref = operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    assert ok_ref.endswith("/TaskHandle")


def test_move_distance_requires_si_units(spec):
    request = spec["components"]["schemas"]["TaskSubmitRequest"]
    variants = request["oneOf"]
    assert len(variants) == 1
    move = schema_of(spec, variants[0])
    assert move["additionalProperties"] is False
    assert {"action", "distance_m"} <= set(move["required"])
    assert "distance" not in move["properties"], "不得声明无单位的 distance"
    distance = move["properties"]["distance_m"]
    speed = move["properties"]["speed_mps"]
    assert distance["x-unit"] == "m"
    assert speed["x-unit"] == "m/s"
    assert move["x-units"] == {"distance_m": "m", "speed_mps": "m/s"}
    assert distance["x-nonzero"] is True
    assert distance["x-min-abs"] == 0.05
    assert distance["minimum"] < 0 < distance["maximum"]
    assert speed["minimum"] < speed["default"] < speed["maximum"]
    assert move["properties"]["action"]["enum"] == ["move_distance"]


def test_task_handle_is_only_a_reference(spec):
    handle = spec["components"]["schemas"]["TaskHandle"]
    assert handle["additionalProperties"] is False
    assert set(handle["required"]) == {"task_id"}
    assert set(handle["properties"]) == {"task_id"}
    # 引用不能携带终态结论；Task 投影才有可选的 episode/result。
    task = spec["components"]["schemas"]["Task"]
    assert "episode" in task["properties"]
    assert "result" in task["properties"]


def test_task_result_separates_lifecycle_goal_and_evidence(spec):
    result = spec["components"]["schemas"]["TaskResult"]
    assert {"lifecycle", "goal_achieved", "evidence"} <= set(result["required"])
    assert schema_of(spec, result["properties"]["lifecycle"])["enum"] == [
        "completed",
        "failed",
        "cancelled",
        "interrupted",
    ]
    evidence = schema_of(spec, result["properties"]["evidence"])["enum"]
    assert evidence == ["unknown", "board_reported", "sensor_verified"]
    goal = result["properties"]["goal_achieved"]
    assert goal["type"] == "boolean" and goal["nullable"] is True

    policy = result["x-task-result-policy"]
    assert policy["invariants"] == [
        "goal_achieved_true_requires_sensor_verified",
        "non_completed_lifecycle_requires_goal_achieved_null",
        "board_reported_is_not_goal_achieved",
    ]
    assert policy["goal_achieved_true_requires"]["evidence"] == "sensor_verified"
    assert policy["goal_achieved_must_be_null_for"] == ["failed", "cancelled", "interrupted"]
    assert policy["evidence_order"] == ["unknown", "board_reported", "sensor_verified"]
    assert policy["motion_done_implies"] == {
        "lifecycle": "completed",
        "goal_achieved": None,
        "evidence": "board_reported",
    }


def test_motion_done_cannot_imply_goal_achieved(events):
    registered = {event["type"]: event for event in events["events"]}
    done = registered["motion.done"]
    assert "goal_achieved" not in done["payload_fields"]
    assert {"task_id", "episode_id", "action", "evidence"} <= set(done["required_fields"])
    source = next(e for e in load_source()["events"] if e["type"] == "motion.done")
    assert source["payload"]["evidence"]["enum"] == ["board_reported"]
    assert "goal_achieved" not in source["payload"]

    aborted = next(e for e in load_source()["events"] if e["type"] == "motion.aborted")
    assert "goal_achieved" not in aborted["payload"]
    assert "sensor_verified" not in aborted["payload"]["evidence"]["enum"]


def test_task_events_never_carry_goal_achieved(events):
    for event in events["events"]:
        if event["type"].startswith("task."):
            assert "goal_achieved" not in event["payload_fields"], event["type"]


def test_stop_confirmation_is_machine_readable(events):
    stop = events["stop_confirmation"]
    assert stop["states"] == ["requested", "confirmed", "unknown"]
    assert stop["confirmed_requires"] == "board_stop_reply_with_matching_request_id"
    assert stop["write_success_is"] == "requested"
    assert stop["unaddressed_stop"]["request_has_id"] is False
    assert stop["unaddressed_stop"]["max_state"] == "unknown"
    assert "confirmed" not in stop["unaddressed_stop"]["allowed_states"]

    requested = next(e for e in events["events"] if e["type"] == "safety.stop_requested")
    source_requested = next(e for e in load_source()["events"] if e["type"] == "safety.stop_requested")
    assert stop["states"] == source_requested["payload"]["state"]["enum"]
    # 关联字段必须登记，否则安全停止无法回到 ActionEpisode 时间线。
    assert "episode_id" in requested["payload_fields"]


# ---------------------------------------------------------------- 实现侧
def test_task_submit_route_is_declared_but_unimplemented(spec):
    routes = {route.operation_id: route for route in build_routes(debug=False)}
    route = routes["task_submit"]
    assert (route.method, route.template) == ("POST", "/v1/tasks")
    assert route.requires_approval is False

    capability = Registry().by_public_name("task_submit")
    assert capability.implementation is Implementation.UNIMPLEMENTED
    assert capability.mcp_exclude is True
    assert capability.requires_approval is False
    assert capability.unavailable_reason

    operation = spec["paths"]["/v1/tasks"]["post"]
    assert operation["operationId"] == route.operation_id


@pytest.mark.parametrize(
    ("body", "fragment"),
    [
        ({"action": "move_distance", "distance": 0.3}, "distance_m"),
        ({"action": "move_distance"}, "distance_m"),
        ({"action": "move_distance", "distance_m": 0}, "distance_m"),
        ({"action": "move_distance", "distance_m": 0.01}, "distance_m"),
        ({"action": "move_distance", "distance_m": 1.0}, "distance_m"),
        ({"action": "move_distance", "distance_m": 0.3, "speed_mps": 0.5}, "speed_mps"),
        ({"action": "robot_move", "distance_m": 0.3}, "action"),
        ({"action": "move_distance", "distance_m": 0.3, "extra": 1}, "extra"),
    ],
)
def test_task_submit_rejects_bad_parameters_before_unimplemented(body, fragment):
    with pytest.raises(RobotdError) as excinfo:
        _h_task_submit(_ctx(body))
    assert excinfo.value.code is ErrorCode.VALIDATION
    assert fragment in excinfo.value.message


def test_task_submit_valid_request_does_not_fabricate_task_id():
    """能力未实现时只能是 503/E_UNAVAILABLE；不得返回临时 task_id。"""
    with pytest.raises(RobotdError) as excinfo:
        _h_task_submit(_ctx({"action": "move_distance", "distance_m": 0.3, "speed_mps": 0.15}))
    assert excinfo.value.code is ErrorCode.UNAVAILABLE
    assert "task_id" not in excinfo.value.to_public()["error"]


def test_no_codex_device_primitives_or_robot_move(tools, spec):
    names = {tool["name"] for tool in tools}
    assert "task_submit" not in names
    assert not any("robot_move" in name or "move_distance" in name for name in names)
    operations = {
        operation.get("operationId")
        for item in spec["paths"].values()
        for operation in item.values()
        if isinstance(operation, dict)
    }
    assert "robot_move" not in operations

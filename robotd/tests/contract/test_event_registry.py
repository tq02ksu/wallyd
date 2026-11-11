"""事件登记表门禁（GH-20）。

契约侧 ``contracts/generated/robotd-events.json`` 已经登记了 robotd 的事件面，
但生产代码此前不读它：``_emit_locked()`` 只校验名字形状，拼错的
``device.recoverd`` 会静默进入序号、日志、补发窗口与订阅者。

本文件守三条不变量：

1. ``robotd/src/`` 里所有经 emit 族入口发出的**字面量**事件名都已登记。
   必须是源码枚举，不是手工清单——手工清单会和代码一起漂移。
2. 登记表里 ``required_fields`` 非空的事件必须在 ``_reduce`` 里有分支。
3. 标了 ``no_state: true`` 的事件必须**没有** ``_reduce`` 分支：
   「合法但只记日志」是显式状态，而不是 ``_reduce`` 末尾那个 pass 分支的隐式结果。
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

from robotd.core.event_registry import load_event_registry

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "robotd" / "src" / "robotd"
KERNEL = SRC / "core" / "kernel.py"
SIM_BOARD = SRC / "devices" / "sim.py"
CONTRACTS = ROOT / "contracts"

#: 所有会最终把事件交给内核（或转给它）的入口名。
#: ``_emit`` 是语音运行时注入的写入口；只扫 ``emit`` 会漏掉整个语音面。
SINK_FUNCTIONS = {"emit", "_emit", "_emit_locked", "_publish_locked", "emit_state", "_audio_emit"}

#: 首参不是字面量的转发点。每一处都必须写明为什么安全，并且由本文件的
#: 其它断言补齐取值域——不允许用 ``continue`` 静默跳过。
PASS_THROUGH = {
    ("core/kernel.py", "EventKernel.emit"): "event_type 原样转给 _emit_locked；登记校验在 _emit_locked 入口",
    ("core/kernel.py", "EventKernel._emit_locked"): "入口已校验，原样转给 _publish_locked",
    ("app.py", "App._audio_emit"): "语音运行时注入的转发器；_audio_emit 的调用点由本测试枚举",
    ("app.py", "App._board_event"): "板侧适配注入的转发器；SimBoard 的上报由本测试枚举，最终仍由内核拒绝",
}


def load(name: str) -> dict:
    return json.loads((CONTRACTS / "generated" / name).read_text(encoding="utf-8"))


def _resolve_literal_names(node: ast.AST, dicts: dict[str, ast.Dict]) -> set[str] | None:
    """把首参表达式还原成它可能取到的事件名字面量集合。

    支持：字符串常量、三元表达式两个分支、元组/列表/集合，以及
    ``event_map[state]`` 这种「用本地字典字面量查表」的写法。
    还原不出来返回 ``None``——调用方必须显式处理，不能当作「没有事件」跳过。
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return {node.value}
    if isinstance(node, ast.IfExp):
        left = _resolve_literal_names(node.body, dicts)
        right = _resolve_literal_names(node.orelse, dicts)
        if left is None or right is None:
            return None
        return left | right
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        found: set[str] = set()
        for item in node.elts:
            resolved = _resolve_literal_names(item, dicts)
            if resolved is None:
                return None
            found |= resolved
        return found
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
        table = dicts.get(node.value.id)
        if table is not None:
            found = set()
            for value in table.values:
                resolved = _resolve_literal_names(value, {})
                if resolved is None:
                    return None
                found |= resolved
            return found
    return None


def _local_dict_literals(fn: ast.FunctionDef) -> dict[str, ast.Dict]:
    """收集函数体内（含 if/with 等复合语句）的 ``name = {字面量}`` 赋值。

    ``finish()`` 的 ``event_map`` 写在 ``with self._lock:`` 里；只看函数体顶层
    语句会把 ``event_map[state]`` 误判成「无法枚举」，从而漏掉三条 task 终态事件。
    嵌套函数/类有自己的作用域，不纳入。
    """
    local: dict[str, ast.Dict] = {}
    stack: list[ast.AST] = list(fn.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    local[target.id] = node.value
        stack.extend(ast.iter_child_nodes(node))
    return local


class _EventCallScanner(ast.NodeVisitor):
    def __init__(self, relpath: str) -> None:
        self.relpath = relpath
        self._scope: list[str] = []
        self._dicts: dict[str, dict[str, ast.Dict]] = {}
        self.names: set[str] = set()
        self.unresolved: set[tuple[str, str]] = set()

    @property
    def qualname(self) -> str:
        return ".".join(self._scope)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._scope.append(node.name)
        self.generic_visit(node)
        self._scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._scope.append(node.name)
        self._dicts[self.qualname] = _local_dict_literals(node)
        self.generic_visit(node)
        self._scope.pop()

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        name = (
            func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
        )
        if name in SINK_FUNCTIONS:
            if not node.args:
                # emit_state() 自己不带事件名；它内部的 _emit("audio.state") 会被单独扫到。
                if name != "emit_state":
                    self.unresolved.add((self.relpath, self.qualname))
            else:
                resolved = _resolve_literal_names(node.args[0], self._dicts.get(self.qualname, {}))
                if resolved is None:
                    self.unresolved.add((self.relpath, self.qualname))
                else:
                    self.names |= resolved
        self.generic_visit(node)


def _scan(path: Path) -> tuple[set[str], set[tuple[str, str]]]:
    relpath = path.relative_to(SRC).as_posix()
    scanner = _EventCallScanner(relpath)
    scanner.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
    return scanner.names, scanner.unresolved


def _scan_source_tree() -> tuple[set[str], set[tuple[str, str]]]:
    names: set[str] = set()
    unresolved: set[tuple[str, str]] = set()
    for path in sorted(SRC.rglob("*.py")):
        found, unresolved_calls = _scan(path)
        names |= found
        unresolved |= unresolved_calls
    return names, unresolved


def _reduce_branch_events() -> set[str]:
    """从 ``_reduce`` 源码里抽取有显式分支的事件名。"""
    tree = ast.parse(KERNEL.read_text(encoding="utf-8"), filename=str(KERNEL))
    reduce_fn = next(
        node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "_reduce"
    )
    branches: set[str] = set()
    for node in ast.walk(reduce_fn):
        if not isinstance(node, ast.Compare) or not isinstance(node.left, ast.Name):
            continue
        if node.left.id != "t":
            continue
        for op, comparator in zip(node.ops, node.comparators):
            if (
                isinstance(op, ast.Eq)
                and isinstance(comparator, ast.Constant)
                and isinstance(comparator.value, str)
            ):
                branches.add(comparator.value)
            elif isinstance(op, ast.In) and isinstance(comparator, (ast.Tuple, ast.List, ast.Set)):
                for item in comparator.elts:
                    if isinstance(item, ast.Constant) and isinstance(item.value, str):
                        branches.add(item.value)
    return branches


# ---------------------------------------------------------------- 登记表边界
def test_registry_boundary_semantics():
    registry = load_event_registry()
    # events[] 的精确名必须与契约源逐个对齐，而不是硬编码总数：别的 PR 新增事件
    # 不应让本文件变红，漏登记一条则必须变红。device.* 只是订阅过滤语义。
    spec = json.loads((CONTRACTS / "events.json").read_text(encoding="utf-8"))
    expected = {event["type"] if isinstance(event, dict) else event for event in spec.get("events", spec)}
    assert registry.exact == expected
    assert not any("*" in name for name in registry.exact)
    assert registry.allows("device.recovered")
    assert not registry.allows("device.recoverd")

    # 预留面按带点前缀放行，且只有这四个前缀。
    assert set(registry.prefixes) == {"vision.", "camera.", "people.", "person."}
    assert registry.allows("vision.detected")
    assert registry.allows("person.track_started")
    assert not registry.allows("visionfoo.x")

    # board.* 是三条精确名，不是通配。
    assert registry.debug == frozenset({"board.log", "board.tx", "board.rx"})
    assert registry.allows("board.log")
    assert not registry.allows("board.anything")


# ---------------------------------------------------------------- 判据 2：源码枚举
def test_all_emitted_event_literals_are_registered():
    names, unresolved = _scan_source_tree()

    # 自检：扫描器漏掉一整片时，下面的「全部已登记」会变成假绿灯。
    assert len(names) > 20, f"只扫到 {len(names)} 个事件名，扫描器很可能漏了注入式入口"
    assert "speech.final" in names, "语音面没被扫到：检查 _emit / emit_state 是否在扫描集合里"
    assert "speech.tts_chunk_finished" in names, "三元表达式分支没被递归收集"

    # 非字面量实参必须逐处交代，不能静默跳过。
    assert unresolved == set(PASS_THROUGH), (
        f"发现未交代的非字面量 emit 实参：{sorted(unresolved - set(PASS_THROUGH))}；"
        f"已失效的白名单：{sorted(set(PASS_THROUGH) - unresolved)}"
    )

    registry = load_event_registry()
    unknown = sorted(name for name in names if not registry.allows(name))
    assert not unknown, f"robotd/src 发出了未登记的事件：{unknown}"


def test_board_adapter_event_literals_are_registered():
    """``App._board_event`` 的值域来自板侧适配；当前只有 SimBoard 这一处实现。"""
    found: set[str] = set()
    tree = ast.parse(SIM_BOARD.read_text(encoding="utf-8"), filename=str(SIM_BOARD))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = (
            func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else None
        )
        if name != "_on_event":
            continue
        assert node.args, "板侧 _on_event 调用必须带事件名"
        resolved = _resolve_literal_names(node.args[0], {})
        assert resolved is not None, "板侧上报的事件名必须是字面量，或在本测试里显式加断言"
        found |= resolved

    assert found, "没有扫到任何板侧事件：检查 SimBoard 的 _on_event 调用"
    registry = load_event_registry()
    unknown = sorted(name for name in found if not registry.allows(name))
    assert not unknown, f"板侧适配发出了未登记的事件：{unknown}"


# ---------------------------------------------------------------- 判据 3：_reduce 对照
def test_required_fields_have_reduce_branch_and_no_state_is_explicit():
    events = load("robotd-events.json")["events"]
    branches = _reduce_branch_events()

    expected_branches = {
        "device.changed",
        "device.lost",
        "device.ready",
        "device.recovered",
        "device.reset",
        "motion.plan",
        "safety.stopped",
    }
    assert branches == expected_branches, (
        f"_reduce 分支集合变了：{sorted(branches)}；新增/删除分支时同步更新 no_state 标记与本断言"
    )

    no_state = {ev["type"] for ev in events if ev.get("no_state") is True}
    unknown_flag = {ev["type"] for ev in events if "no_state" in ev and not isinstance(ev["no_state"], bool)}
    assert not unknown_flag, f"no_state 必须是布尔值：{sorted(unknown_flag)}"

    # 双向：没标 no_state 的必须有分支；标了 no_state 的不许有分支。
    assert not (branches & no_state), f"标了 no_state 却有 _reduce 分支：{sorted(branches & no_state)}"
    missing = {ev["type"] for ev in events} - branches - no_state
    assert not missing, f"既没有 _reduce 分支也没标 no_state：{sorted(missing)}"

    # required_fields 非空的事件要么有 _reduce 分支，要么显式标 no_state；
    # 「有必填字段、既不改状态、又没声明 no_state」才是注定的静默事件。
    required_without_branch = {
        ev["type"]
        for ev in events
        if ev.get("required_fields") and ev["type"] not in branches and ev["type"] not in no_state
    }
    assert not required_without_branch, (
        f"required_fields 非空却既没有 _reduce 分支也没标 no_state：{sorted(required_without_branch)}"
    )

"""GH-84 架构门禁：robotd import 契约 + legacy allowlist 棘轮。

判据（离线 L2）：

1. 真实源码树没有未允许的违规；
2. 故意新增 ``device -> task`` / ``motion -> api`` / ``api -> device`` 时门禁变红；
   ``from pkg import submodule`` 与相对导入的 alias 也必须解析成真实模块名；
   同一行（``motion`` / ``device``）的模块之间互相 import 同样变红；
3. legacy allowlist 只减不增：清单条目必须 ⊆ 本文件钉死的基线，且失效条目会让测试变红。
4. 违规必须让 CI 的入口返回非零退出码，而不只是扫描器认得。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))

from check_imports import (  # noqa: E402
    LAYERS,
    apply_allowlist,
    check,
    load_allowlist,
    main,
    scan,
)

ALLOWLIST = ROOT / "robotd" / "architecture-allowlist.json"

#: 引入本门禁时的 legacy 违规基线。**只能删，不能增**：
#: 任何新增允许项都必须同时改这里，从而在 review 里显式暴露。
LEGACY_ALLOWLIST_BASELINE: frozenset[tuple[str, str, str]] = frozenset()


def test_real_tree_has_no_unallowlisted_import_violations():
    remaining, stale = check(ROOT, ALLOWLIST)
    assert remaining == [], [f"{v.importer} -> {v.imported} ({v.rule})" for v in remaining]
    assert stale == [], "allowlist 里有已失效条目：已修好的违规必须从清单删除"


def test_legacy_allowlist_only_shrinks():
    entries = load_allowlist(ALLOWLIST)
    keys = {(e["importer"], e["imported"], e["rule"]) for e in entries}
    assert keys <= LEGACY_ALLOWLIST_BASELINE, (
        "不允许新增 legacy import 例外；请修正依赖方向，或先在设计文档里论证并更新基线"
    )
    assert len(entries) <= len(LEGACY_ALLOWLIST_BASELINE)


def test_layers_are_declared_top_to_bottom():
    """分层顺序是契约本身：api > app > safety > task > motion/device > core > interfaces。"""
    assert LAYERS[0] == ("robotd.api",)
    assert LAYERS[-1] == ("robotd.interfaces",)
    assert ("robotd.motion", "robotd.device") in LAYERS
    for layer in LAYERS:
        for module in layer:
            base = ROOT / "robotd" / "src" / Path(*module.split("."))
            assert base.is_dir() or base.with_suffix(".py").exists(), module


def _write_tree(root: Path, relative: str, source: str) -> None:
    path = root / "robotd" / "src" / "robotd" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")


@pytest.mark.parametrize(
    "relative, importer, imported, rule",
    [
        # 判据 1：三类必须变红的违规 import。
        ("device/board.py", "robotd.device.board", "robotd.task.executive", "forbidden"),
        ("motion/arbiter.py", "robotd.motion.arbiter", "robotd.api.http", "forbidden"),
        ("api/http.py", "robotd.api.http", "robotd.device.sim", "forbidden"),
        # 分层违规：device import 上层 safety。
        ("device/board.py", "robotd.device.board", "robotd.safety.stop", "layers"),
        # interfaces 是最底层，import 任何 robotd 模块都是分层违规。
        ("interfaces/ports.py", "robotd.interfaces.ports", "robotd.core.types", "layers"),
    ],
)
def test_violating_import_turns_the_gate_red(tmp_path, relative, importer, imported, rule):
    _write_tree(tmp_path, relative, f"from {imported} import something\n")
    violations = scan(tmp_path)
    assert any(v.importer == importer and v.imported == imported and v.rule == rule for v in violations), (
        violations
    )
    remaining, stale = apply_allowlist(violations, [])
    assert remaining and not stale


@pytest.mark.parametrize(
    "relative, source, importer, imported",
    [
        # 绝对名 + alias：``node.module`` 只是 ``robotd``，目标藏在 ``node.names`` 里。
        ("device/board.py", "from robotd import task\n", "robotd.device.board", "robotd.task"),
        # 相对名 + alias：``from .. import task`` 在 ``robotd.device.board`` 里指向 ``robotd.task``。
        ("device/board.py", "from .. import task\n", "robotd.device.board", "robotd.task"),
    ],
)
def test_aliased_from_import_is_expanded_to_the_real_module(tmp_path, relative, source, importer, imported):
    """``from pkg import submodule`` 不能因为只解析了 ``node.module`` 就绕过门禁。"""
    # 目标模块真实存在（门禁解析的是 import 图）；这里复刻 ``robotd.task`` 包。
    _write_tree(tmp_path, "task/__init__.py", "")
    _write_tree(tmp_path, relative, source)
    violations = scan(tmp_path)
    assert any(
        v.importer == importer and v.imported == imported and v.rule == "forbidden" for v in violations
    ), violations


def test_from_module_import_is_not_turned_into_a_phantom_submodule(tmp_path):
    """``from mod import SomeClass`` 只依赖 ``mod``，不能凭空多出一条 ``mod.SomeClass``。"""
    _write_tree(tmp_path, "task/__init__.py", "")
    _write_tree(tmp_path, "task/executive.py", "")
    _write_tree(tmp_path, "device/board.py", "from robotd.task.executive import TaskExecutive\n")
    found = {(v.importer, v.imported, v.rule) for v in scan(tmp_path)}
    assert found == {("robotd.device.board", "robotd.task.executive", "forbidden")}


def test_plain_import_of_a_submodule_is_caught(tmp_path):
    """``import robotd.task`` 与 ``from robotd import task`` 是同一个依赖，必须同样变红。"""
    _write_tree(tmp_path, "task/__init__.py", "")
    _write_tree(tmp_path, "device/board.py", "import robotd.task\n")
    violations = scan(tmp_path)
    assert any(
        v.importer == "robotd.device.board" and v.imported == "robotd.task" and v.rule == "forbidden"
        for v in violations
    ), violations


@pytest.mark.parametrize(
    "source, imported",
    [
        # ``import robotd`` 之后走属性链：AST 里没有 ImportFrom，但依赖真实存在。
        (
            "import robotd\n\n\ndef f():\n    return robotd.task.executive.TaskExecutive\n",
            "robotd.task.executive",
        ),
        # 给包起别名同样能绕过根名检查。
        (
            "import robotd as r\n\n\ndef f():\n    return r.task.executive.TaskExecutive\n",
            "robotd.task.executive",
        ),
    ],
)
def test_module_attribute_chain_is_caught(tmp_path, source, imported):
    """``import robotd`` + ``robotd.task.x`` 不能绕过 ``device -> task``。"""
    _write_tree(tmp_path, "task/__init__.py", "")
    _write_tree(tmp_path, "task/executive.py", "")
    _write_tree(tmp_path, "device/board.py", source)
    violations = scan(tmp_path)
    assert any(
        v.importer == "robotd.device.board" and v.imported == imported and v.rule == "forbidden"
        for v in violations
    ), violations


def test_module_name_in_a_string_is_not_a_dependency(tmp_path):
    """日志名、错误文案里出现的 ``robotd.task`` 是字符串，不是 import，不能误报。"""
    _write_tree(tmp_path, "task/__init__.py", "")
    _write_tree(tmp_path, "device/board.py", 'import logging\n\nlog = logging.getLogger("robotd.task")\n')
    assert scan(tmp_path) == []


def test_attribute_on_the_package_itself_is_not_a_dependency(tmp_path):
    """``robotd.__version__`` 不是一个模块依赖，不该被当成 ``robotd`` 违规。"""
    _write_tree(tmp_path, "device/board.py", "import robotd\n\nVERSION = robotd.__version__\n")
    assert scan(tmp_path) == []


@pytest.mark.parametrize(
    "relative, importer, imported",
    [
        # 同一行的模块互不依赖：两个方向都必须变红。
        ("device/board.py", "robotd.device.board", "robotd.motion.arbiter"),
        ("motion/arbiter.py", "robotd.motion.arbiter", "robotd.device.sim"),
    ],
)
def test_same_layer_siblings_cannot_import_each_other(tmp_path, relative, importer, imported):
    _write_tree(tmp_path, relative, f"from {imported} import something\n")
    violations = scan(tmp_path)
    assert any(
        v.importer == importer and v.imported == imported and v.rule == "siblings" for v in violations
    ), violations


@pytest.mark.parametrize(
    "relative, source",
    [
        # 同一行里的同一个模块前缀（自己的子模块）不是兄弟依赖，不能被误判。
        ("motion/arbiter.py", "from robotd.motion.types import Resource\n"),
        ("device/board.py", "from robotd.device.sim import SimBoard\n"),
    ],
)
def test_same_layer_module_may_use_its_own_submodules(tmp_path, relative, source):
    _write_tree(tmp_path, relative, source)
    assert scan(tmp_path) == []


def test_cli_entry_point_exits_nonzero_on_a_deliberate_violation(tmp_path):
    """判据要在 CI 上变红：走 ``main()`` 的退出码，而不只是扫描器认得违规。"""
    _write_tree(tmp_path, "task/__init__.py", "")
    _write_tree(tmp_path, "device/board.py", "from robotd import task\n")
    assert main(["--root", str(tmp_path)]) == 1


def test_cli_entry_point_exits_zero_on_a_clean_tree(tmp_path):
    """反向对照：同一个入口在干净树上必须返回 0，证明上面的 1 不是硬编码。"""
    _write_tree(tmp_path, "device/board.py", "from robotd.core.types import DeviceStatus\n")
    assert main(["--root", str(tmp_path)]) == 0


def test_allowlisting_a_violation_silences_it_and_becomes_stale_once_fixed(tmp_path):
    """ratchet 机制本身：允许项生效；修好之后必须删除，否则门禁仍红。"""
    _write_tree(tmp_path, "device/board.py", "from robotd.task.executive import TaskExecutive\n")
    violations = scan(tmp_path)
    entry = {
        "importer": "robotd.device.board",
        "imported": "robotd.task.executive",
        "rule": "forbidden",
        "reason": "negative-test fixture",
    }
    remaining, stale = apply_allowlist(violations, [entry])
    assert remaining == [] and stale == []

    _write_tree(tmp_path, "device/board.py", "from robotd.core.types import DeviceStatus\n")
    remaining, stale = apply_allowlist(scan(tmp_path), [entry])
    assert remaining == []
    assert stale == [entry], "违规修好后 allowlist 条目变成失效项，必须删除"

"""GH-84 架构门禁：robotd import 契约 + legacy allowlist 棘轮。

判据（离线 L2）：

1. 真实源码树没有未允许的违规；
2. 故意新增 ``device -> task`` / ``motion -> api`` / ``api -> device`` 时门禁变红；
3. legacy allowlist 只减不增：清单条目必须 ⊆ 本文件钉死的基线，且失效条目会让测试变红。
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

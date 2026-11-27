#!/usr/bin/env python3
"""robotd 的静态 import 契约门禁（import-linter 的离线等价物）。

为什么不用 import-linter 本体：运行环境没有外网，``uv sync``/pip 装不了新依赖。
这里只用标准库 AST，规则与 import-linter 的 ``layers`` + ``forbidden`` 同构，
并多一个 legacy allowlist：清单里的违规必须写明理由，且只能减不能增（棘轮由
``robotd/tests/architecture/test_import_contracts.py`` 锁死）。

用法::

    python3 scripts/ci/check-imports.py --root .

退出码：0 = 通过；1 = 有未允许的违规，或 allowlist 里有已失效条目。
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import dataclass
from pathlib import Path

#: 分层（从上到下）。同一行的模块互不依赖；下层不得 import 上层。
LAYERS: tuple[tuple[str, ...], ...] = (
    ("robotd.api",),
    ("robotd.app",),
    ("robotd.safety",),
    ("robotd.task",),
    ("robotd.motion", "robotd.device"),
    ("robotd.core",),
    ("robotd.interfaces",),
)

#: 显式禁止的依赖边（from -> to）：即使分层放行，这些方向也不允许。
FORBIDDEN: tuple[tuple[str, str, str], ...] = (
    ("robotd.device", "robotd.task", "device -> task：设备层不得依赖任务生命周期"),
    ("robotd.motion", "robotd.api", "motion -> api：运动资源不得依赖 agent adapter"),
    ("robotd.api", "robotd.device", "api -> device：agent adapter 不得触碰设备内部"),
)


@dataclass(frozen=True)
class Violation:
    importer: str
    imported: str
    rule: str
    detail: str

    def matches(self, entry: dict) -> bool:
        return (
            entry.get("importer") == self.importer
            and entry.get("imported") == self.imported
            and entry.get("rule") == self.rule
        )

    def to_dict(self) -> dict:
        return {
            "importer": self.importer,
            "imported": self.imported,
            "rule": self.rule,
            "detail": self.detail,
        }


def module_name(path: Path, src: Path) -> str:
    parts = list(path.relative_to(src).with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    # ``src`` 的下一层就是 ``robotd`` 包本身，路径已带包名，不能再补一次前缀。
    return ".".join(parts)


def imported_modules(path: Path, module: str) -> set[str]:
    """该文件直接 import 的 robotd 模块（绝对名）。解析不了的目标跳过。"""
    is_package = path.name == "__init__.py"
    base = module if is_package else module.rpartition(".")[0]
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
        if isinstance(node, ast.ImportFrom):
            if node.level:
                parts = base.split(".") if base else []
                for _ in range(node.level - 1):
                    parts = parts[:-1]
                if node.module:
                    parts = [*parts, node.module]
            else:
                parts = (node.module or "").split(".")
            target = ".".join(part for part in parts if part)
            if target:
                found.add(target)
        elif isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
    return {name for name in found if name == "robotd" or name.startswith("robotd.")}


def _layer_of(module: str) -> int | None:
    for index, layer in enumerate(LAYERS):
        if any(module == prefix or module.startswith(f"{prefix}.") for prefix in layer):
            return index
    return None


def _forbidden_rule(importer: str, imported: str) -> str | None:
    for source, target, detail in FORBIDDEN:
        if (importer == source or importer.startswith(f"{source}.")) and (
            imported == target or imported.startswith(f"{target}.")
        ):
            return detail
    return None


def scan(root: Path) -> list[Violation]:
    """扫描 ``<root>/robotd/src/robotd`` 的 import 图。"""
    src = root / "robotd" / "src"
    package = src / "robotd"
    violations: list[Violation] = []
    for path in sorted(package.rglob("*.py")):
        importer = module_name(path, src)
        for imported in sorted(imported_modules(path, importer)):
            forbidden = _forbidden_rule(importer, imported)
            if forbidden is not None:
                violations.append(Violation(importer, imported, "forbidden", forbidden))
                continue
            source_layer = _layer_of(importer)
            target_layer = _layer_of(imported)
            if source_layer is None or target_layer is None:
                continue  # 未列入契约的顶层模块（config/capabilities/...）不参与分层
            if source_layer > target_layer:
                violations.append(
                    Violation(
                        importer,
                        imported,
                        "layers",
                        f"{importer} 在下层，不得 import 上层的 {imported}",
                    )
                )
    return violations


def load_allowlist(path: Path) -> list[dict]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError(f"{path} 必须是 {{'version': 1, 'entries': [...]}}")
    entries = data.get("entries", [])
    if not isinstance(entries, list):
        raise ValueError(f"{path}: entries 必须是数组")
    for entry in entries:
        for key in ("importer", "imported", "rule", "reason"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                raise ValueError(f"{path}: 条目缺字段 {key}：{entry!r}")
    return entries


def apply_allowlist(violations: list[Violation], entries: list[dict]) -> tuple[list[Violation], list[dict]]:
    """返回（未允许的违规, 已失效的 allowlist 条目）。"""
    remaining: list[Violation] = []
    used: set[int] = set()
    for violation in violations:
        match = next((i for i, entry in enumerate(entries) if violation.matches(entry)), None)
        if match is None:
            remaining.append(violation)
        else:
            used.add(match)
    stale = [entry for index, entry in enumerate(entries) if index not in used]
    return remaining, stale


def check(root: Path, allowlist_path: Path) -> tuple[list[Violation], list[dict]]:
    return apply_allowlist(scan(root), load_allowlist(allowlist_path))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="仓库根（默认当前目录）")
    parser.add_argument(
        "--allowlist",
        default=None,
        help="legacy allowlist JSON（默认 <root>/robotd/architecture-allowlist.json）",
    )
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    allowlist_path = (
        Path(args.allowlist).resolve()
        if args.allowlist
        else root / "robotd" / "architecture-allowlist.json"
    )
    remaining, stale = check(root, allowlist_path)
    for violation in remaining:
        print(f"FAIL {violation.rule}: {violation.importer} -> {violation.imported}（{violation.detail}）")
    for entry in stale:
        print(
            "STALE allowlist entry "
            f"{entry['importer']} -> {entry['imported']}（{entry['rule']}）：已不是违规，请删除"
        )
    if remaining or stale:
        print(f"import contract failed: {len(remaining)} new, {len(stale)} stale", file=sys.stderr)
        return 1
    print("import contract ok")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

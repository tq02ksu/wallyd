#!/usr/bin/env python3
"""robotd 的静态 import 契约门禁（import-linter 的离线等价物）。

为什么不用 import-linter 本体：运行环境没有外网，``uv sync``/pip 装不了新依赖。
这里只用标准库 AST，规则与 import-linter 的 ``layers`` + ``forbidden`` 同构，
再加一条「同一行的模块互不依赖」（rule=``siblings``），
并多一个 legacy allowlist：清单里的违规必须写明理由，且只能减不能增（棘轮由
``robotd/tests/architecture/test_import_contracts.py`` 锁死）。

用法::

    python3 scripts/ci/check_imports.py --root .

退出码：0 = 通过；1 = 有未允许的违规，或 allowlist 里有已失效条目。
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import dataclass
from pathlib import Path

#: 分层（从上到下）。同一行的模块互不依赖（兄弟边也禁止）；下层不得 import 上层。
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


def _known_modules(package: Path) -> set[str]:
    """扫描树里真实存在的模块/包名（含隐式父包）。"""
    src = package.parent
    known: set[str] = set()
    for path in package.rglob("*.py"):
        parts = module_name(path, src).split(".")
        for end in range(1, len(parts) + 1):
            known.add(".".join(parts[:end]))
    return known


def imported_modules(path: Path, module: str, known: set[str]) -> set[str]:
    """该文件直接 import 的 robotd 模块（绝对名）。解析不了的目标跳过。

    ``from pkg import name`` 里 ``name`` 可能是子模块：只解析 ``node.module`` 会把
    ``from robotd import task`` 误当成 ``robotd``，从而绕过 ``device -> task``。
    因此把 ``node.module`` 与每个 alias 一起展开成候选绝对名（``*`` 除外），
    但只有扫描树里真实存在的模块才算数——``from mod import SomeClass`` 导入的是
    属性，不会变成一个幽灵子模块，也不会污染 allowlist 的精确匹配。

    ``import robotd`` 后直接用属性访问（``robotd.task.executive``）同样是依赖，
    但 AST 里没有 ``ImportFrom``；所以再解析一次属性链，取 ``known`` 里最长前缀。
    ``importlib.import_module("robotd.task")`` / ``__import__("robotd.task")`` 是同一
    依赖的标准库写法，字面量目标同样展开（非字面量判不出来，不猜）。
    字符串常量（``logging.getLogger("robotd.task")``）不是 import，不计入。
    """
    is_package = path.name == "__init__.py"
    base = module if is_package else module.rpartition(".")[0]
    found: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    aliases = _module_aliases(tree)
    dynamic_calls = _dynamic_import_callables(tree)
    for node in ast.walk(tree):
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
            # alias 可能是子模块（``from robotd import task`` / ``from .. import task``）。
            for alias in node.names:
                if alias.name == "*":
                    continue
                candidate = f"{target}.{alias.name}" if target else alias.name
                if candidate in known:
                    found.add(candidate)
        elif isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.Attribute):
            # ``import robotd`` / ``import robotd as r`` 之后的 ``robotd.task.x``。
            resolved = _attribute_module(_dotted(node), aliases, known)
            if resolved is not None:
                found.add(resolved)
        elif isinstance(node, ast.Call):
            # 动态 import：``importlib.import_module("robotd.task")`` / ``__import__(...)``。
            if _dotted(node.func) in dynamic_calls:
                target = _literal_first_arg(node)
                if target is not None:
                    resolved = _longest_known_prefix(target, known)
                    if resolved is not None:
                        found.add(resolved)
    return {name for name in found if name == "robotd" or name.startswith("robotd.")}


def _literal_first_arg(node: ast.Call) -> str | None:
    """``Call`` 的第一个位置参数是字符串字面量时返回它；其余返回 ``None``。"""
    if not node.args:
        return None
    first = node.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return None


def _dynamic_import_callables(tree: ast.AST) -> set[str]:
    """本文件里指向动态 import 的可调用名（本地写法 → ``__import__`` 语义）。

    ``importlib.import_module`` 的三种常见本地形态都算：
    ``importlib.import_module``、``import importlib as il`` 后的 ``il.import_module``、
    ``from importlib import import_module [as load]`` 后的本地名；外加内建 ``__import__``。
    """
    callables = {"__import__"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "importlib":
                    callables.add(f"{alias.asname or 'importlib'}.import_module")
        elif isinstance(node, ast.ImportFrom) and node.module == "importlib" and not node.level:
            for alias in node.names:
                if alias.name == "import_module":
                    callables.add(alias.asname or "import_module")
    return callables


def _longest_known_prefix(name: str, known: set[str]) -> str | None:
    """把模块名解析到扫描树里真实存在的最长前缀；包根 ``robotd`` 不算依赖。"""
    parts = name.split(".")
    for end in range(len(parts), 0, -1):
        candidate = ".".join(parts[:end])
        if candidate in known:
            return candidate if candidate != "robotd" else None
    return None


def _dotted(node: ast.AST) -> str:
    """纯属性链的 ``a.b.c`` 形式；根不是名字时返回空串。"""
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return ""


def _module_aliases(tree: ast.AST) -> dict[str, str]:
    """``import robotd as r`` 的本地名 → 模块名。无别名的 import 不需要（名字不变）。"""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    aliases[alias.asname] = alias.name
    return aliases


def _attribute_module(dotted: str, aliases: dict[str, str], known: set[str]) -> str | None:
    """把属性链解析成真实模块（取最长已知前缀）；根不是 robotd 模块时返回 ``None``。"""
    if not dotted:
        return None
    root, _, rest = dotted.partition(".")
    base = aliases.get(root, root if root == "robotd" else None)
    if base is None:
        return None
    full = f"{base}.{rest}" if rest else base
    parts = full.split(".")
    for end in range(len(parts), 0, -1):
        candidate = ".".join(parts[:end])
        if candidate in known:
            # ``robotd`` 本身不提供依赖方向（``robotd.__version__`` 不是模块依赖）。
            return candidate if candidate != "robotd" else None
    return None


def _layer_entry(module: str) -> tuple[int, str] | None:
    """返回 ``(层序号, 该行里匹配到的模块前缀)``；未列入契约时返回 ``None``。"""
    for index, layer in enumerate(LAYERS):
        for prefix in layer:
            if module == prefix or module.startswith(f"{prefix}."):
                return index, prefix
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
    known = _known_modules(package)
    violations: list[Violation] = []
    for path in sorted(package.rglob("*.py")):
        importer = module_name(path, src)
        source = _layer_entry(importer)
        for imported in sorted(imported_modules(path, importer, known)):
            forbidden = _forbidden_rule(importer, imported)
            if forbidden is not None:
                violations.append(Violation(importer, imported, "forbidden", forbidden))
                continue
            if source is None:
                continue  # 未列入契约的顶层模块（config/capabilities/...）不参与分层
            target = _layer_entry(imported)
            if target is None:
                continue
            source_layer, source_row = source
            target_layer, target_row = target
            if source_layer > target_layer:
                violations.append(
                    Violation(
                        importer,
                        imported,
                        "layers",
                        f"{importer} 在下层，不得 import 上层的 {imported}",
                    )
                )
            elif source_layer == target_layer and source_row != target_row:
                # 同一行的模块互不依赖：motion 与 device 是并列资源，谁都不许 import 谁。
                violations.append(
                    Violation(
                        importer,
                        imported,
                        "siblings",
                        f"{importer} 与 {imported} 在同一层，模块之间不得互相 import",
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
        Path(args.allowlist).resolve() if args.allowlist else root / "robotd" / "architecture-allowlist.json"
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
        print(
            f"import contract failed: {len(remaining)} new, {len(stale)} stale",
            file=sys.stderr,
        )
        return 1
    print("import contract ok")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

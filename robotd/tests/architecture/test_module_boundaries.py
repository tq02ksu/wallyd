"""GH-84 源码级边界：内核/App/HTTP/音频/设备装配各自只做自己的事。

import 图（``test_import_contracts.py``）只能证明模块之间没有互相依赖；这里补上
「职责没有偷偷留在旧层里」的源码断言，对应 issue 的判据 3 与 7。
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "robotd" / "src" / "robotd"

TASK_API = {
    "_finish_locked",
    "_require_task",
    "expire_paused_task",
    "finish",
    "get_task",
    "list_tasks",
    "mark_running",
    "new_task",
    "pause_task",
    "resume_task",
    "set_progress",
}


def _source(relpath: str) -> str:
    return (SRC / relpath).read_text(encoding="utf-8")


def _tree(relpath: str) -> ast.Module:
    return ast.parse(_source(relpath), filename=relpath)


def _class(tree: ast.Module, name: str) -> ast.ClassDef:
    return next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)


def _methods(node: ast.ClassDef) -> set[str]:
    return {item.name for item in node.body if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))}


def _dotted(node: ast.AST) -> str:
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _called_names(tree: ast.Module) -> set[str]:
    return {_dotted(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}


# ---------------------------------------------------------------- EventKernel
def test_event_kernel_has_no_task_table_or_task_api():
    tree = _tree("core/kernel.py")
    kernel = _class(tree, "EventKernel")
    assert _methods(kernel).isdisjoint(TASK_API), _methods(kernel) & TASK_API
    text = _source("core/kernel.py")
    assert "self._tasks" not in text
    assert "self._motion_task" not in text
    assert "self._task_seq" not in text


def test_event_kernel_keeps_sequence_commit_snapshot_and_subscriptions():
    """保留项不能被这次抽取误删。"""
    kernel = _class(_tree("core/kernel.py"), "EventKernel")
    methods = _methods(kernel)
    assert {"emit", "commit", "snapshot", "subscribe", "resume", "read"} <= methods


# ---------------------------------------------------------------- App
def test_app_implements_no_task_stop_or_calibration_policy():
    app = _class(_tree("app.py"), "App")
    assert _methods(app).isdisjoint(
        {
            "pause_task",
            "resume_task",
            "request_stop",
            "report_safety_stop",
            "read_calibration",
            "write_calibration",
            "audio_state",
            "set_audio_muted",
            "_announce_pause_expired",
            "_on_utterance_done",
            "_on_response_done",
        }
    )
    text = _source("app.py")
    # 不允许 App 直接改任务或下发停止（停止策略在 safety）。
    assert ".tasks.finish(" not in text
    assert ".kernel.commit(" not in text
    assert 'notify("stop"' not in text


def test_app_is_the_composition_root():
    text = _source("app.py")
    for wiring in (
        "self.motion = ResourceArbiter(",
        "self.tasks = TaskExecutive(",
        "self.audio = AudioRuntime(",
        "self.safety = StopCoordinator(",
        "self.calibration = CalibrationService(",
        "completion=self.tasks",
        "board=lambda: self.board",
    ):
        assert wiring in text, wiring


# ---------------------------------------------------------------- HTTP handler
def test_http_handlers_do_not_own_task_or_stop_policy():
    called = _called_names(_tree("api/http.py"))
    forbidden = {
        "ctx.app.kernel.new_task",
        "ctx.app.kernel.mark_running",
        "ctx.app.kernel.finish",
        "ctx.app.kernel.pause_task",
        "ctx.app.kernel.resume_task",
        "ctx.app.kernel.get_task",
        "ctx.app.kernel.list_tasks",
        "ctx.app.tasks.finish",
        "ctx.app.request_stop",
    }
    assert called.isdisjoint(forbidden), called & forbidden
    # 薄 handler 只经端口操作任务与停止。
    assert "ctx.app.tasks.submit" in called
    assert "ctx.app.tasks.pause" in called
    assert "ctx.app.safety.request_stop" in called
    assert "ctx.app.safety.cancel_task" in called


# ---------------------------------------------------------------- AudioRuntime
def test_audio_runtime_reports_facts_through_a_completion_port():
    text = _source("core/audio_runtime.py")
    for forbidden in ("from ..task", "from ..safety", "from ..app", "TaskState", "TaskError"):
        assert forbidden not in text, forbidden
    assert ".kernel." not in text
    assert "completion: TaskCompletionPort | None = None" in text
    assert "self.completion.utterance_finished(" in text
    assert "self.completion.response_finished(" in text
    # 不再保留音频层直接驱动任务收尾的裸回调。
    assert "on_utterance_done" not in text
    assert "on_response_done" not in text


# ---------------------------------------------------------------- 设备构造
def test_device_objects_are_constructed_only_by_the_composition_root():
    constructors = {"SimBoard", "AudioBridge"}
    found: dict[str, set[str]] = {}
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _dotted(node.func) in constructors:
                found.setdefault(_dotted(node.func), set()).add(path.relative_to(SRC).as_posix())
    assert found, "扫描器没有找到任何设备构造，说明检查失效"
    for name, files in found.items():
        assert files <= {"app.py"}, f"{name} 只允许由 Composition Root 构造，实际：{files}"


def test_seam_modules_are_real_and_used():
    """六个最小模块都必须真实存在且被源码引用（不是空目录）。"""
    for package in ("interfaces", "task", "motion", "device", "safety"):
        assert (SRC / package / "__init__.py").exists(), package
    everything = "".join(path.read_text(encoding="utf-8") for path in SRC.rglob("*.py"))
    importers = {
        "interfaces": "interfaces.ports import",
        "task": "task.executive import",
        "motion": "motion.arbiter import",
        "device": "device.calibration import",
        "safety": "safety.stop import",
    }
    for package, importer in importers.items():
        assert importer in everything, f"{package} 没有被真实使用"

"""常驻语音桥适配（R14）：robotd ↔ ``AudioBridge.app`` 的进程与管道管理。

## 为什么是这个形状（见 ADR-0011）

macOS 的 TCC **按责任进程判定权限**：从 robotd（或终端）直接 ``spawn`` 出来的二进制，
其责任进程是 robotd 的宿主 App，TCC 去查那个 App 的授权记录 → 采集/识别被拒甚至 SIGABRT。
所以桥必须是**独立的 .app bundle**，并由 ``open`` 经 LaunchServices 启动，权限才归桥自己。

``open`` 提供 ``--stdin / --stdout / --stderr`` 三个重定向，于是：

```text
robotd ──写──▶ bridge.in (FIFO) ──stdin──▶ AudioBridge.app
robotd ◀─读─── bridge.out (文件，tail) ◀──stdout──┘
```

**为什么 stdout 用文件而不是 FIFO**：``open`` 只接受**路径**，打开一个管道做写端会让
``open`` 自己阻塞到有人读；而如果用 FIFO 当 stdout，桥退出后 robotd 读到 EOF 就分不清
「桥退出了」还是「桥暂时没话」。用文件 + 轮询偏移，robotd 能同时看到「没有新行」与
「进程已不在」（``pid`` 检查），两种故障因此可区分——这正是 R14 要求的
「桥退出不能伪装为成功听音」。

## 纪律

- **不把「已拉起」当成「可用」**：只有收到桥的 ``bridge_ready`` 才算 ``ready``，
  并带上桥自报的采集格式。否则一律 ``starting`` / ``lost`` / ``unavailable``。
- **桥退出必须可见**：进程消失 → ``lost`` + 原因；当前 utterance 以
  ``no_speech`` 之外的明确错误收尾，绝不返回空文本冒充「听过了但没说话」。
- **不静默重试**：连续崩溃 3 次后停止自动拉起，避免把用户的 CPU 打满。
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from ..core.types import DeviceStatus

log = logging.getLogger("robotd.devices.audio_bridge")

#: 桥自报就绪的超时。冷启动要初始化 AVAudioEngine + ASR 资产，实测 2~4s 量级。
READY_TIMEOUT_S = 15.0
#: 轮询 stdout 文件的间隔。事件天然是"人说话"的量级，50ms 足够且不烧 CPU。
POLL_INTERVAL_S = 0.05
#: 连续崩溃多少次后放弃自动拉起
MAX_CRASHES = 3


class AudioBridgeUnavailable(RuntimeError):
    """桥不可用（找不到 App / 起不来 / 权限缺失）。**带上可读原因**，供 audio.state 展示。"""


class AudioBridge:
    """一个常驻语音桥子进程的句柄。

    线程模型：一个读线程轮询 stdout 文件并把事件投给 ``on_event``；
    ``call`` 类操作（listen/speak/stop）直接写 stdin，HTTP 线程可以安全调用（写侧有锁）。
    """

    def __init__(
        self,
        *,
        app_path: Path,
        work_dir: Path,
        locale: str = "zh_CN",
        on_event: Callable[[dict[str, Any]], None],
        aec: bool = True,
    ) -> None:
        self.app_path = app_path
        self.work_dir = work_dir
        self.locale = locale
        self.on_event = on_event
        self.aec = aec

        self._proc: subprocess.Popen[bytes] | None = None
        self._out_path: Path | None = None
        self._in_fd: int | None = None
        self._write_lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._offset = 0
        self._crashes = 0

        #: 桥自报的就绪信息（采集格式等）；None 表示还没就绪
        self.ready_info: dict[str, Any] | None = None
        self.last_error: str | None = None
        self.status = DeviceStatus.UNKNOWN

    # ------------------------------------------------------------ 生命周期
    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def ready(self) -> bool:
        """桥是否已就绪。

        **未就绪 ≠ 不可用**：``starting``/``unknown`` 都算未就绪，调用方据此报
        ``E_UNAVAILABLE`` 并带原因，而不是尝试发命令后静默丢帧。
        """
        return self.status is DeviceStatus.READY and self._in_fd is not None

    def start(self) -> None:
        """启动桥并等待 ``bridge_ready``。失败抛 :class:`AudioBridgeUnavailable`。"""
        if self._proc is not None:
            return
        if not self.app_path.exists():
            raise AudioBridgeUnavailable(
                f"未找到语音桥 {self.app_path}（先按 docs/voice-architecture.md 构建 AudioBridge.app）"
            )
        # 清残留
        self._close_pipes()
        run_dir = Path(tempfile.mkdtemp(prefix="audiobridge-", dir=str(self.work_dir)))
        fifo = run_dir / "bridge.in"
        out = run_dir / "bridge.out"
        err = run_dir / "bridge.err"
        os.mkfifo(fifo)
        out.touch()
        err.touch()
        self._out_path = out
        self._offset = 0
        self._stop.clear()
        self._ready.clear()
        self.ready_info = None
        self.status = DeviceStatus.STARTING

        # **必须用 open（LaunchServices）；直接 spawn 会回到 ADR-0011 的 TCC 失败路径**
        args = [
            "open",
            "-n",  # 新实例，不复用可能残留的旧进程
            "-a",
            str(self.app_path),
            "--stdin",
            str(fifo),
            "--stdout",
            str(out),
            "--stderr",
            str(err),
            "--args",
            "serve",
            "--locale",
            self.locale,
        ]
        if not self.aec:
            args.append("--no-aec")
        try:
            subprocess.run(args, check=True, capture_output=True, timeout=10)
        except (subprocess.SubprocessError, OSError) as exc:
            self.status = DeviceStatus.LOST
            raise AudioBridgeUnavailable(f"open 无法启动语音桥：{exc}") from exc

        # open 只负责拉起；真正打开 FIFO 阻塞写侧的是桥自己。这里以写方式打开会阻塞，
        # 直到桥把 stdin 打开——用一个后台线程做，避免卡住 robotd 启动。
        self._reader = threading.Thread(target=self._read_loop, name="audiobridge-reader", daemon=True)
        self._reader.start()

        if not self._ready.wait(timeout=READY_TIMEOUT_S):
            self.status = DeviceStatus.LOST
            reason = self._tail(err) or "超时未收到 bridge_ready"
            self.close()
            raise AudioBridgeUnavailable(f"语音桥未就绪：{reason}")

    def _open_stdin(self) -> None:
        """在后台线程里打开 FIFO 写端（桥才会打开读端，二者互相等待）。"""
        assert self._out_path is not None
        fifo = self._out_path.parent / "bridge.in"
        for _ in range(300):  # 最多等 15s
            if self._stop.is_set():
                return
            try:
                # O_NONBLOCK 首次打开避免死等；拿到 fd 后立刻转回阻塞模式，
                # 否则管道写满时 os.write 会抛 EAGAIN（而不是像普通管道那样等待）。
                fd = os.open(str(fifo), os.O_WRONLY | os.O_NONBLOCK)
                flags = fcntl.fcntl(fd, fcntl.F_GETFL)
                fcntl.fcntl(fd, fcntl.F_SETFL, flags & ~os.O_NONBLOCK)
                self._in_fd = fd
                return
            except OSError:
                time.sleep(POLL_INTERVAL_S)
        self.last_error = "无法打开桥的 stdin（桥可能没起来）"
        self._ready.set()  # 让 start() 尽快返回并报错

    def close(self) -> None:
        self._stop.set()
        try:
            self.send({"cmd": "quit"}, best_effort=True)
        except Exception:  # noqa: BLE001
            pass
        self._close_pipes()
        self._proc = None

    def _close_pipes(self) -> None:
        if self._in_fd is not None:
            try:
                os.close(self._in_fd)
            except OSError:
                pass
            self._in_fd = None
        if self._out_path is not None:
            shutil.rmtree(self._out_path.parent, ignore_errors=True)
            self._out_path = None

    # ------------------------------------------------------------ 读
    def _read_loop(self) -> None:
        self._open_stdin()
        assert self._out_path is not None
        buf = b""
        while not self._stop.is_set():
            try:
                with open(self._out_path, "rb") as fh:
                    fh.seek(self._offset)
                    chunk = fh.read()
                    self._offset = fh.tell()
            except OSError:
                chunk = b""
            if chunk:
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self._dispatch(line)
            elif self._saw_exit():
                # 桥进程没了：明确报 lost，让上层把当前 utterance 判失败
                self.status = DeviceStatus.LOST
                reason = self.last_error or "语音桥进程已退出"
                log.warning("语音桥退出：%s", reason)
                self.on_event({"ev": "bridge_exit", "reason": reason})
                return
            time.sleep(POLL_INTERVAL_S)

    def _saw_exit(self) -> bool:
        """判断桥是否已经不在。

        ``open`` 启动的是**独立进程**（不是 open 的子进程），所以 ``self._proc`` 恒为 None、
        ``poll()`` 也判不出来。优先用桥自报的 pid（``bridge_ready.pid``，最准）；
        还没就绪时退回 pgrep 按可执行路径找——两种方式都返回「找不到」才算退出，
        避免把「刚起来还没报 ready」误判成崩溃。
        """
        pid = (self.ready_info or {}).get("pid")
        if isinstance(pid, int):
            try:
                os.kill(pid, 0)  # 只探测存在性，不发信号
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
            else:
                return False
        exe = str(self.app_path / "Contents" / "MacOS" / self.app_path.stem)
        try:
            out = subprocess.run(
                ["pgrep", "-f", exe], capture_output=True, timeout=2, text=True
            ).stdout.strip()
        except (subprocess.SubprocessError, OSError):
            return False
        return not out

    def _dispatch(self, line: bytes) -> None:
        try:
            event = json.loads(line.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            log.debug("桥输出非 JSON：%r", line[:200])
            return
        if event.get("ev") == "bridge_ready":
            self.ready_info = event
            self.status = DeviceStatus.READY
            self.last_error = None
            self._crashes = 0
            self._ready.set()
        elif event.get("ev") == "error":
            self.last_error = str(event.get("message") or event.get("code") or "桥报错")
            log.warning("语音桥报错：%s", self.last_error)
            if not self._ready.is_set():
                self._ready.set()  # 让 start() 立刻失败返回
        self.on_event(event)

    def _tail(self, path: Path, limit: int = 400) -> str:
        try:
            return path.read_text(errors="replace").strip()[-limit:]
        except OSError:
            return ""

    # ------------------------------------------------------------ 写
    def send(self, cmd: dict[str, Any], *, best_effort: bool = False) -> None:
        if self._in_fd is None:
            if best_effort:
                return
            raise AudioBridgeUnavailable("语音桥 stdin 未打开")
        data = (json.dumps(cmd, ensure_ascii=False) + "\n").encode("utf-8")
        with self._write_lock:
            try:
                os.write(self._in_fd, data)
            except OSError as exc:
                self.last_error = f"向语音桥写入失败：{exc}"
                if not best_effort:
                    raise AudioBridgeUnavailable(self.last_error) from exc

    # ------------------------------------------------------------ 状态
    def state(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "pid": self._proc.pid if self._proc else None,
            "running": self.running,
            "last_error": self.last_error,
            "ready": self.ready_info,
        }

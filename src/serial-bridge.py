#!/usr/bin/env python3
"""POC 串口桥（Python 标准库，无三方依赖）。

为什么需要它：本板（ESP32-S3 + FTDI）的 DTR/RTS 经三极管接到 EN/IO0，**拉高即把芯片按在
复位态**；Python 的 termios 可以 ioctl 把它们清零，而 Node 没有 ioctl 能力。所以串口由这个
进程独占，Node 侧只跟 stdio 说话——对应设计文档里「只有原生才能做的事」那类桥。

用法：
  # 中继模式（供 robotd 使用）
  python3 serial-bridge.py --port /dev/cu.usbserial-A5069RR4
      stdin   : 一行 = 往板子写一行（自动补 \n）
      stdout  : 板子回来的完整行（原样，未解析）
      stderr  : 诊断日志

  # 探针模式（人工排查）
  python3 serial-bridge.py --listen 3 --send status --send hello

由 robotd 以子进程方式拉起；本身是 src/ 下的入库代码。
"""
from __future__ import annotations

import argparse
import fcntl
import os
import select
import struct
import sys
import termios
import threading
import time

DEFAULT_PORT = "/dev/cu.usbserial-A5069RR4"


def set_lines(fd, dtr, rts):
    """DTR/RTS 清零——不清零则芯片一直在复位态，读不到任何输出。"""
    for value, mask in ((dtr, termios.TIOCM_DTR), (rts, termios.TIOCM_RTS)):
        req = termios.TIOCMBIS if value else termios.TIOCMBIC
        fcntl.ioctl(fd, req, struct.pack("I", mask))


def open_port(port, baud, dtr, rts):
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    b = getattr(termios, "B%d" % baud)
    iflag, oflag, cflag, lflag, _is, _os, cc = termios.tcgetattr(fd)
    iflag = 0                       # raw
    oflag &= ~termios.OPOST
    lflag = 0
    cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
    cc[termios.VMIN] = 0
    cc[termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, b, b, cc])
    termios.tcflush(fd, termios.TCIOFLUSH)
    set_lines(fd, dtr, rts)
    return fd


def log(msg):
    print("[bridge] " + msg, file=sys.stderr, flush=True)


def reader_loop(fd, stop):
    """串口 → stdout，按行输出。"""
    buf = b""
    while not stop.is_set():
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            continue
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            sys.stdout.write(line.decode("utf-8", "replace").rstrip("\r") + "\n")
            sys.stdout.flush()
    if buf:
        sys.stdout.write(buf.decode("utf-8", "replace").rstrip("\r") + "\n")
        sys.stdout.flush()


def relay(fd):
    """stdin 一行 → 板子一行；同时把板子输出打到 stdout。"""
    stop = threading.Event()
    threading.Thread(target=reader_loop, args=(fd, stop), daemon=True).start()
    try:
        for raw in sys.stdin:
            line = raw.rstrip("\n")
            if line == "":
                continue
            os.write(fd, (line + "\n").encode())
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        stop.set()
        time.sleep(0.1)
    return 0


def probe(fd, seconds, sends, wait_before=2.5):
    stop = threading.Event()
    threading.Thread(target=reader_loop, args=(fd, stop), daemon=True).start()
    # 打开串口会复位这块板：等它真的跑起来再发，否则命令会打在 ROM 启动阶段上。
    time.sleep(wait_before)
    for line in sends:
        log("send %r" % line)
        os.write(fd, (line + "\n").encode())
        time.sleep(0.4)
    time.sleep(max(0.0, seconds))
    stop.set()
    time.sleep(0.15)
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default=DEFAULT_PORT)
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--dtr", type=int, default=0, help="1 拉高（多数情况会把板子按在复位态）")
    ap.add_argument("--rts", type=int, default=0)
    ap.add_argument("--listen", type=float, default=None, help="探针模式：听 N 秒后退出")
    ap.add_argument("--send", action="append", default=[], help="探针模式：依次发送的行")
    ap.add_argument("--wait-before", type=float, default=2.5, help="探针模式：开串口后等多久再发")
    args = ap.parse_args()

    fd = open_port(args.port, args.baud, bool(args.dtr), bool(args.rts))
    log("opened %s @ %d dtr=%s rts=%s" % (args.port, args.baud, bool(args.dtr), bool(args.rts)))
    try:
        if args.listen is not None:
            return probe(fd, args.listen, args.send, args.wait_before)
        return relay(fd)
    finally:
        os.close(fd)
        log("closed")


if __name__ == "__main__":
    sys.exit(main())

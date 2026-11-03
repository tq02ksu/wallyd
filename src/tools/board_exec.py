#!/usr/bin/env python3
"""在板子上执行一段 MicroPython 代码（raw REPL），把输出打到 stdout。

用法：
  python3 board_exec.py --code "print('hi')"
  python3 board_exec.py --file snippet.py --wait 3
串口走本目录 `lib/pyshim`（仅标准库 termios）。
"""
import argparse
import os
import select
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from pyshim.serial import Serial  # noqa: E402


def drain(ser, seconds):
    out = b""
    t0 = time.time()
    while time.time() - t0 < seconds:
        r, _, _ = select.select([ser.fd], [], [], 0.05)
        if r:
            out += ser.read(8192)
            t0 = time.time()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/cu.usbserial-A5069RR4")
    ap.add_argument("--code")
    ap.add_argument("--file")
    ap.add_argument("--wait", type=float, default=2.0)
    ap.add_argument("--no-boot-wait", action="store_true")
    args = ap.parse_args()

    code = args.code or ""
    if args.file:
        with open(args.file) as f:
            code = f.read()

    ser = Serial(args.port, 115200, timeout=0.3)
    ser.reset_input_buffer()
    if not args.no_boot_wait:
        drain(ser, 1.5)                      # 打开串口会触发一次复位，等它起来
    ser.write(b"\x03")                       # 打断 main.py 的循环
    time.sleep(0.25)
    ser.write(b"\x03")
    drain(ser, 0.4)
    ser.write(b"\x01")                       # raw REPL
    drain(ser, 0.4)
    ser.write(code.encode())
    time.sleep(0.2)
    ser.write(b"\x04")
    out = drain(ser, args.wait)
    try:
        ser.write(b"\x02")
    except OSError:
        pass
    ser.close()
    sys.stdout.write(out.decode("utf-8", "replace"))


if __name__ == "__main__":
    main()

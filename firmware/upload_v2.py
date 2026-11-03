#!/usr/bin/env python3
"""把 robot_server_v2.py 上传成板子的 main.py（raw REPL + base64 分块，带长度校验）。

为什么用 base64 分块：raw REPL 对超长粘贴不友好，而逐行转义写入容易被引号/反斜杠咬到。
串口走 `lib/pyshim`（仅标准库 termios）。
"""
import argparse
import base64
import os
import select
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from pyshim.serial import Serial  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, "robot_server_v2.py")


def drain(ser, seconds):
    out = b""
    t0 = time.time()
    while time.time() - t0 < seconds:
        r, _, _ = select.select([ser.fd], [], [], 0.05)
        if r:
            out += ser.read(8192)
            t0 = time.time()
    return out


def raw_exec(ser, code, wait=0.5):
    ser.write(b"\x01")          # Ctrl-A -> raw REPL
    time.sleep(0.12)
    drain(ser, 0.15)
    ser.write(code.encode())
    time.sleep(0.15)
    ser.write(b"\x04")          # Ctrl-D -> 执行
    return drain(ser, wait).decode("utf-8", "replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/cu.usbserial-A5069RR4")
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--chunk", type=int, default=512)
    ap.add_argument("--target", default="main.py")
    ap.add_argument("--no-reset", action="store_true")
    args = ap.parse_args()

    with open(args.src, "rb") as f:
        blob = f.read()
    payload = base64.b64encode(blob).decode()
    chunks = [payload[i:i + args.chunk] for i in range(0, len(payload), args.chunk)]
    print("[upload] %s -> %d bytes, base64 %d chars in %d chunks"
          % (os.path.basename(args.src), len(blob), len(payload), len(chunks)))

    ser = Serial(args.port, 115200, timeout=0.3)
    ser.reset_input_buffer()
    drain(ser, 1.5)                      # 打开串口会复位一次
    ser.write(b"\x03")
    time.sleep(0.25)
    ser.write(b"\x03")
    drain(ser, 0.4)

    for i, chunk in enumerate(chunks):
        mode = "wb" if i == 0 else "ab"
        code = (
            "import ubinascii\n"
            "f=open('%s','%s')\n"
            "f.write(ubinascii.a2b_base64('%s'))\n"
            "f.close()\n"
            "print('CHUNK %d')\n" % (args.target, mode, chunk, i)
        )
        out = raw_exec(ser, code)
        if ("CHUNK %d" % i) not in out:
            print("[upload] FAILED at chunk %d: %r" % (i, out[-300:]))
            ser.close()
            return 1
        sys.stdout.write(".")
        sys.stdout.flush()
    print()

    check = raw_exec(ser, "print('SIZE', len(open('%s','rb').read()))\n" % args.target, wait=0.6)
    print("[upload] verify:", check.strip().replace("\r", ""))
    good = ("SIZE %d" % len(blob)) in check

    if not args.no_reset:
        ser.write(b"\x02")               # 退出 raw REPL
        time.sleep(0.2)
        ser.write(b"\x04")               # 软复位 -> 跑新的 main.py
        boot = drain(ser, 2.5).decode("utf-8", "replace")
        print("[upload] boot log:", boot.strip()[-400:])
        if "ready" not in boot:
            print("[upload] !! 没看到固件 ready 行：main.py 可能编译失败掉回 REPL，请检查语法")
    ser.close()
    print("[upload] %s" % ("OK" if good else "SIZE MISMATCH"))
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""从板子读回 main.py（raw REPL），用于替换 POC 固件前的备份。

这块板打开串口会因 DTR/RTS 自动复位电路重启一次，所以流程是：
开串口 → 等启动 → Ctrl-C 打断 main.py 循环 → Ctrl-A 进 raw REPL → 发代码 → Ctrl-D 执行 → 收输出。
目标机没装 pyserial，串口走本目录 `lib/pyshim`（仅标准库 termios）。
"""
import os
import select
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from pyshim.serial import Serial  # noqa: E402  （pyshim，仅标准库 termios）

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbserial-A5069RR4"
OUT = sys.argv[2] if len(sys.argv) > 2 else "work/poc/firmware/board_main_backup.py"
MARK_A = "===DUMP-START==="
MARK_B = "===DUMP-END==="


def drain(ser, seconds):
    out = b""
    t0 = time.time()
    while time.time() - t0 < seconds:
        r, _, _ = select.select([ser.fd], [], [], 0.1)
        if r:
            out += ser.read(4096)
            t0 = time.time()
    return out


ser = Serial(PORT, 115200, timeout=0.3)
ser.reset_input_buffer()

boot = drain(ser, 2.0)
print("[dump] boot tail: %r" % boot[-120:], file=sys.stderr)

ser.write(b"\x03")
time.sleep(0.3)
ser.write(b"\x03")
time.sleep(0.3)
print("[dump] after ctrl-c: %r" % drain(ser, 0.6)[-160:], file=sys.stderr)

ser.write(b"\x01")
print("[dump] raw repl: %r" % drain(ser, 0.8)[-120:], file=sys.stderr)

code = (
    "f=open('main.py')\n"
    "_s=f.read()\n"
    "f.close()\n"
    "print('%s'+str(len(_s))+'%s')\n"
    "print(_s)\n"
    "print('%s')\n" % (MARK_A, MARK_B, MARK_B)
)
ser.write(code.encode())
time.sleep(0.3)
ser.write(b"\x04")
raw = drain(ser, 3.0)

try:
    ser.write(b"\x02")
except OSError:
    pass
ser.close()

text = raw.decode("utf-8", "replace")
sys.stderr.write("[dump] raw tail: %r\n" % text[-200:])
if MARK_A in text and MARK_B in text:
    # 注意：raw REPL 会把源码本身回显一遍，所以要取**最后一次**出现的标记。
    body = text.rsplit(MARK_A, 1)[1].rsplit(MARK_B, 1)[0]
    header, _, content = body.partition("\n")
    declared = header.strip()
    with open(OUT, "w") as f:
        f.write(content)
    print("[dump] declared=%s saved=%s bytes=%d -> %s"
          % (declared, len(content), len(content.encode()), OUT), file=sys.stderr)
else:
    print("[dump] FAILED (no markers); raw saved to /tmp/board_dump_raw.txt", file=sys.stderr)
    with open("/tmp/board_dump_raw.txt", "w") as f:
        f.write(text)

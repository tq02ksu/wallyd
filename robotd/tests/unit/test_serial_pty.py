"""GH-74 判据 2 的另一半证据：真的 pyserial + 真的 tty 设备路径。

用 POSIX 伪终端（pty）代替板子：host 侧是 ``SerialBoard``，测试从 master 端读字节、
回 hello 应答。不接硬件、不产生位移事实，只证明「打开设备 → 写出帧 → 读到应答」。
"""

from __future__ import annotations

import os
import time

import pytest

from robotd.devices.serial import SerialBoard
from tests.helpers import PseudoBoard

pytest.importorskip("serial")
pytestmark = pytest.mark.skipif(not hasattr(os, "openpty"), reason="需要 POSIX pty")


def test_real_serial_round_trip_and_move_frame_bytes():
    board_side = PseudoBoard()
    board = SerialBoard(board_side.path, 115200, timeout_s=0.05)
    try:
        hello = board.request("hello", {"proto": 2})
        assert hello == {"fw": "pty-2.0"}
        board.request("move", {"left": 0.3, "right": 0.3, "speed": 0.15})
        deadline = time.monotonic() + 2
        while len(board_side.received) < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert board_side.received[1] == {
            "id": 2,
            "op": "move",
            "args": {"left": 0.3, "right": 0.3, "speed": 0.15},
        }, board_side.received
        board.notify("stop")
        deadline = time.monotonic() + 2
        while len(board_side.received) < 3 and time.monotonic() < deadline:
            time.sleep(0.005)
        assert board_side.received[2] == {"op": "stop"}, board_side.received
    finally:
        board.close()
        board_side.close()

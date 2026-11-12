"""设备适配层。真机串口见 ``serial``（GH-74 最小切口），仿真板见 ``sim``；
原生桥（R12）仍在此层落地。"""

from __future__ import annotations

__all__ = ["serial", "sim"]

"""设备适配层：板侧（仿真板 / R11 串口）、语音桥、标定。

设备对象只由 Composition Root（``robotd.app``）构造并注入；本模块不 import
``task``/``safety``/``app``，也不知道任务生命周期。
"""

from __future__ import annotations

__all__ = ["audio_bridge", "calibration", "sim"]

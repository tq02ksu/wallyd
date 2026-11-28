"""逻辑运动资源。

``ResourceArbiter`` 决定 ``base_motion`` 等逻辑资源归谁持有；它不是 ros2_control 的
硬件 ResourceManager，也不碰电机或串口——只对权威任务记录做准入判定。
"""

from .arbiter import BASE_MOTION, ResourceArbiter

__all__ = ["BASE_MOTION", "ResourceArbiter"]

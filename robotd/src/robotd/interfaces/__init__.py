"""跨模块端口（Protocol）。

端口层是最低层：这里不 import 任何 robotd 模块，只声明「模块之间可以依赖什么」。
实现放在各自模块里（``device`` 实现板侧端口，``task`` 实现音频完成端口，
``app`` 提供时钟与播报适配），由 Composition Root 注入。
"""

from .ports import BoardPort, Clock, SystemAnnouncer, TaskCompletionPort

__all__ = ["BoardPort", "Clock", "SystemAnnouncer", "TaskCompletionPort"]

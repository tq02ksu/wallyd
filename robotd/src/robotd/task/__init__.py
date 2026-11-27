"""Task Executive：RobotTask / ActionEpisode 的唯一状态转移决策者。

它决定「受理、进度、暂停、恢复、终态、到期收尾」，把结果写进 State Store 的工作
副本；EventKernel 在同一把锁里原子提交状态、序号与事件。它不持有事件日志、
不碰串口，也不直接播报——外部动作都经 ``interfaces`` 的端口。
"""

from .executive import TaskExecutive

__all__ = ["TaskExecutive"]

---
title: 机器人项目 — 决策日志
type: project
description: 机器人项目的 ADR 决策日志：每条决策为什么这么定、代价是什么、怎么验证；含待回填清单与格式参考。
tags: [project, robot, adr]
domain: robot
project: macmini-robot
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-06T09:20:00+08:00 }
---

# 机器人项目 — 决策日志

> 规则与 ADR 骨架见本项目 [AGENTS.md](../../AGENTS.md)「文档与决策」「ADR 骨架」两节。
> **一条 ADR 只记一个决策**；设计文档写"是什么"，这里写"为什么"。

## 已记录

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [ADR-0001](0001-vision-fast-slow.md) | 视觉走快慢双路径：实时检测器 + 语义 VLM，暂不引入 YOLO | accepted |
| [ADR-0002](0002-closed-loop-layering.md) | 闭环分两层：编码器读取在 ESP32、低频修正与标定在 robotd | accepted |
| [ADR-0003](0003-timing-constraints-layering.md) | 时间约束分层已成立：原地保留，补两个跨层参数（速度指令频率、打断延迟上限） | proposed |
| [ADR-0004](0004-serial-contract-redlines.md) | 串口契约 v2 已成形：补「不可知状态」红线与 `stop`/`estop` 取消语义 | proposed |
| [ADR-0005](0005-contract-upgrade-v2.md) | 契约升级到 v2：板侧线协议与模型帧补「可发现 + 可断言」，立「厂商格式不得直通 Agent」红线 | proposed |
| [ADR-0006](0006-robotd-event-driven-core.md) | robotd 以事件循环为内核、状态单点持有；进程间以「订阅」而非「查询」互联（不引消息中间件） | proposed |
| [ADR-0007](0007-agentd-robotd-boundary.md) | 独立面板契约、运行时公开接口；审批适配器归 agentd，身体能力与执行前授权校验归 robotd（2026-10-23 确认，待实施） | accepted |
| [ADR-0008](0008-robotd-control-worker.md) | robotd 用 Control Worker 隔离导航与管理事件循环（Node 方案已取代，时序与安全要求保留） | superseded by ADR-0009 |
| [ADR-0009](0009-robotd-python-runtime.md) | robotd 新架构采用 Python，为感知与 SLAM 扩展准备；不合并 modeld 进程 | accepted |
| [ADR-0010](0010-robotd-python-control-isolation.md) | robotd Python 控制隔离与串口所有权：候选 A（独立控制进程），五条所有权/存活/背压/时序/关闭规定 | proposed |
| [ADR-0011](0011-audio-bridge-app-bundle-tcc.md) | 音频桥做成 .app bundle、由 robotd 用 open 拉起：TCC 按责任进程判定权限，直接 spawn 必崩 | accepted |

## 待回填（散在各自文档里的决策）

这些本来就是 ADR 的料，等有空逐条补：

| 候选决策 | 现在写在哪 |
| --- | --- |
| TB6600 输入光耦必须用「拉低 / 高阻」两态制 | [[stepper-wiring]] §2.3、[[electrical-architecture]] §5.3 |
| 串口必须由原生辅助进程持有（Node 清不掉 DTR/RTS） | [[poc/design]] §3 决策 2 |
| MCP 只是接口，不是内部架构（Agent 不得绕过工具面） | [[poc/design]] §3 决策 1 |
| 固件运动必须是分片状态机（v1 阻塞式 ⇒ 抢占与看门狗不成立） | [[poc/design]] §3 决策 3 |
| 引脚口径单一事实源 = 电气架构 §5.2 | [[electrical-architecture]] §5.2 |
| 摄像头换真 UVC（两颗 ZC0301 判死） | [[spec/camera-detection]] §0.3 |
| 语音走系统能力（SpeechAnalyzer / AVSpeechSynthesizer），不用模型 | [[model-selection]] §6.4 |
| ~~语音从一次性桥改为常驻流式管线~~ → 已落为 [ADR-0011](0011-audio-bridge-app-bundle-tcc.md)（进程形态部分） | [[voice-architecture]] §3/§4/§5 |

## 格式参考（中文写作，格式按这些来）

- Michael Nygard《[Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)》(2011) —— ADR 的开创文，Title / Status / Context / Decision / Consequences。
- [MADR](https://github.com/adr/madr) —— Markdown 原生模板（本项目骨架是它的精简中文化）。
- [adr.github.io](https://adr.github.io/) —— 社区主页，术语与工具索引。
- [arc42 §9 Architecture decisions](https://docs.arc42.org/section-9/) —— 文档模板里的决策章节。
- [AWS Prescriptive Guidance · ADR process](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html) —— 流程：接受后不可改写，变更要新开一条并标 superseded。

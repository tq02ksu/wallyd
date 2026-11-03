---
title: ADR-0001 视觉走快慢双路径（实时检测器 + 语义 VLM），暂不引入 YOLO
type: project
description: 机器人视觉分两条路——实时闭环用系统检测器（4–20ms），开放语义理解用 VLM（0.84s/帧）；YOLO 暂不引入，等需要系统给不出的类别再说。
tags: [adr, robot, vision]
domain: robot
project: macmini-robot
adr_status: accepted
date: 2026-10-06
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-06T09:20:00+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/architecture.md
  - predicate: depends-on
    target: /eval/vision-latency.md
---

# ADR-0001 视觉走快慢双路径（实时检测器 + 语义 VLM），暂不引入 YOLO

## 背景

车要用摄像头干两类完全不同的事：一类是**"怎么走"**（避障、找目标，需要连续的坐标/框，控制回路
10–50Hz）；另一类是**"这是什么"**（开放式理解、问答，秒级也行）。设计上先定了 VLM（miniCPM-V），
但一直没回答"要不要再上一个 YOLO 检测器"，而且延迟都是猜测值。

2026-10-06 用 COCO val2017 公开图在目标机上实测了两条路径（[[eval/vision-latency|实测记录]]）：
VLM **0.84s/帧**；macOS 自带 Vision **4–20ms/次**（动物检测 4–7ms 还带框）。快路径比 VLM 快约
**100–200×**。

## 决策驱动

- 控制回路要 10–50Hz ⇒ 单帧必须在**几十毫秒**级（VLM 差了 2 个数量级）。
- 目标机是 Mac mini（M4 / 统一内存），能本地跑，但**不想背多余依赖与权重**。
- 这是要分发/售卖的平台 ⇒ 依赖的**许可**也算成本。

## 考虑的选项

- **A. 只用 VLM**：一条路走到底，实现最简单。
- **B. VLM + YOLO**：慢通道 VLM，快通道上 YOLO（Ultralytics 系）。
- **C. VLM + 系统自带 Vision**：慢通道 VLM，快通道先用 macOS 的 Vision framework。

## 决定

选择 **C**：语义问答走 VLM，实时回路先用**系统自带 Vision**；**YOLO 暂不引入**。

理由：系统 Vision 零下载、零许可、已在目标机上实测 4–20ms（50–250fps），足够 `Nav` 避障/找目标起步；
而 YOLO 带来的增量只有"通用 80 类"这一项，眼下用不到，却要额外背权重 + **AGPL-3.0** 许可。

## 后果

- 好：视觉链路当天就能开工，不依赖任何额外权重；许可干净；快慢分工有实测数字支撑，不是拍脑袋。
- 坏：只能用系统给的类别（人 / 脸 / 动物 / 矩形 / 显著性 / 前景掩码），**认不出"杯子""充电底座""门"**；
  真到那天仍要引检测器，这份工作只是推迟、没有省掉。
- 中性：VLM 必须**抽帧调用**（实测预热 2.1s + 0.84s/帧），不能进控制回路——这条现在是硬约束。

## 怎么验证

- 延迟：`eval/` 的脚本可复跑，数字见 [[eval/vision-latency|实测记录]]。
- 分工是否守住：`Nav` 的实时回路里**不允许**出现对 `modeld` 的调用（属 P1 时间尺度判据，
  见 [[architecture|架构设计]] §1）。
- 引 YOLO 的触发条件：当出现"系统 Vision 给不出的类别"这个真实需求时，另开一条 ADR（本条的 supersede）。

## 相关资料

- [[eval/vision-latency|视觉延迟实测（2026-10-06）]] —— 数字与复现方法
- [[architecture|架构设计]] §10.3（两条感知路径）/ §10.5（Nav 为什么不能塞 VLM）
- [[risk-assessment|风险清单]] R4

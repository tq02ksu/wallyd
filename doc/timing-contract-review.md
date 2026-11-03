---
title: 时间约束与接口契约 — 现状核实
type: project
description: 按「时间约束」与「接口契约」两条判据对项目现状做一次证据级核实：区分「已实现 / 已定稿未实现 / 真空白」三态，附每条结论的出处，供架构评审与下一步排序使用。
tags: [project, robot, review]
domain: robot
project: macmini-robot
sources: []
generated: { by: assistant:workbuddy, at: 2026-10-18T22:29:10+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0003-timing-constraints-layering.md
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0004-serial-contract-redlines.md
---

# 时间约束与接口契约 — 现状核实

> 核实时点：2026-10-18｜方法：逐条读代码 / 协议 / ADR，每条结论标注出处。
> **三态定义**：**已实现**（代码可跑）｜**已定稿未实现**（文档有，代码没有）｜**真空白**（无结论）。

## 0. 结论速览

| 议题 | 判定 | 一句话 |
| --- | --- | --- |
| 时间约束分层（P1） | ✅ **已实现且被实测支撑** | 脉冲/看门狗在 ESP32、决策在 robotd，全部有实测数字 |
| 接口契约（P3 契约） | ✅ **主体已定稿** | 帧格式/命令集/错误码/版本/心跳齐全，POC 验证过 |
| 线协议空洞 | ⚠️ **两条红线未成文** | 「不可知状态不许伪造」「`stop` vs `estop`」→ ADR-0004 |
| 跨层参数 | ⚠️ **两处无单一归属** | 速度指令频率、打断延迟上限 → ADR-0003 |
| 硬件闭环 | ❌ **真空白** | 编码器未接、`STEPS_PER_M` 仍是占位值 → ADR-0002 待落地 |

**整体判断**：**时间与契约两条判据在项目里都已有实质进展，不是空白。**
本次评估的价值在于**把「已实现 / 已定稿 / 真空白」分清楚**，避免把已做完的事当新问题重做、
也避免把真空白当成已解决。

## 1. 时间约束现状

### 1.1 已有实测数字（出处：固件常量注释、协议 §9）

| 参数 | 值 | 出处 | 性质 |
| --- | --- | --- | --- |
| 主循环节拍 | `TICK_MS = 20`（50Hz） | `robot_server_v2.py` | 已实现 |
| 心跳超时 | `HEARTBEAT_TIMEOUT_MS = 300` | 同上 | 已实现 |
| 看门狗实测 | 停心跳 → **420ms 内**自主停机 | 协议 §9（[x]） | **已实测** |
| `stop` 最坏延迟 | ~20ms @1200pps（每 24 步轮询） | 固件 `POLL_EVERY_STEPS` 注释 | 已实现 |
| 脉冲块长 | `CHUNK_MS = 250`（53ms 块掉速 14%，实测） | 固件注释 | **已实测** |
| 累加器上限 | `DT_CAP_MS = 500`（<块长会掉速 21%，实测） | 固件注释 | **已实测** |
| 软件方波上限 | `MAX_RATE = 1500` pps | 固件注释 | 已实现 |
| 串口稳定性 | 115200 + 20ms tick，1600 步/1.33s 无丢包 | 协议 §9（[x]） | **已实测** |

### 1.2 缺口（→ ADR-0003）

1. **速度指令更新频率**：协议写「≥5Hz」、固件内部 50Hz、ADR-0002 写「修正 10–50Hz」——
   三处并存，**没有一处声明是两层独立的**。补：契约层 ≥5Hz（host）+ 板侧 50Hz（内部）。
2. **打断延迟上限**：只有实测值，**无承诺值**。补：`stop` ≤50ms、看门狗 ≤500ms（留 2× 余量）。

### 1.3 一个必须澄清的前提

本项目**自写 MicroPython 固件（`robot_server_v2.py`）**，**不用 FluidNC、不用 G 代码**。
因此任何 CNC 固件的参数（如「G 代码打断 ~120ms」）**与本项目无关**，不应作为评估依据。

## 2. 接口契约现状

### 2.1 已定稿（出处：协议 §3）

帧格式（JSON-Lines + id 回填）、命令集（9 条）、错误模型（5 码）、版本协商（`hello.proto`）、
心跳（≥5Hz / 300ms）、超时重试（命令 500ms、运动不重试）、单位（米/弧度/秒）、
单一契约源（`contracts/openapi.yaml` + `generated/` + `contract:check` 门禁）。

### 2.2 POC 已验证的契约行为（出处：协议 §9 的 [x] 项）

- MCP 走 stdio（`codex exec`）可用；长任务进度**不能**走 MCP，走 WS。
- 串口 JSON 行抖动稳定（115200）。
- 心跳频率 + 300ms 阈值**有效**。
- 板子复位/重启后的状态对齐**已修**（`boot` 事件 → 作废 task + `pose.valid=false` + 重新握手）。

### 2.3 缺口（→ ADR-0004）

1. **「不可知状态」红线未成文**：开环下「到位/物理静止/堵转」无权威来源，
   须显式规定**不提供**这些字段（宁缺勿假）。
2. **取消语义未区分**：`stop`（有序停，已有）与 `estop`（急停+脱机，**待实现**）须分开。
3. **单位单一声明位置**：以 `hello` 为准，禁止别处另立。

## 3. 真空白清单（需要动手，不是文档问题）

| 项 | 现状 | 阻塞于 |
| --- | --- | --- |
| 编码器读取 + 「应发 vs 实走」上报 | 全库无 `encoder`/`PID`/`odom` | 硬件未接（ADR-0002 待落地） |
| `STEPS_PER_M` / `WHEEL_BASE_MM` 真实标定 | 仍是 `8000.0` / `120.0` 占位值 | 装车实测 |
| 电机真实动作 | 固件 `DRIVE_MOTORS=True`（左驱台面测过，右驱待验） | 装车 |
| 限位 / 急停硬件 | 未验 | 硬件 |
| `estop` 命令 | 命令集无此条 | ADR-0004 落地 |

## 4. 下一步建议（按依赖排序）

1. **先落两个 ADR 的红线**（纯文档，无依赖）：ADR-0003 / ADR-0004 转 `accepted`。
2. **`estop` 实现**（ADR-0004）：固件加最高优先级路径 + 契约加 op + MCP 工具面加 `motion.estop`。
3. **装车标定**（ADR-0002）：轮径×细分 → `steps_per_m`，`persist` 掉电读回验证。
4. **复测两个承诺值**（ADR-0003）：`stop` ≤50ms、看门狗 ≤500ms。

## 相关页面

- [[decisions/0003-timing-constraints-layering|ADR-0003 时间约束分层]]
- [[decisions/0004-serial-contract-redlines|ADR-0004 串口契约红线]]
- [[decisions/0002-closed-loop-layering|ADR-0002 闭环分层]]
- [[communication-protocol|分层通信与接口设计]]
- [[architecture|架构设计]] §1.6 职责边界判据

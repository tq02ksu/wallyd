---
title: ADR-0004 串口契约 v2 已成形——补「不可知状态」红线与取消语义
type: project
description: 原则三复核：帧格式/命令集/错误码/版本协商/心跳均已定稿且 POC 验证，契约主体成立；真正缺的是两条显式红线——「开环下不提供到位/静止/堵转字段」与「stop 与 estop 语义区分」，以及单位口径的单一声明位置。
tags: [adr, robot, contract, protocol]
domain: robot
project: macmini-robot
adr_status: proposed
date: 2026-10-18
sources: []
generated: { by: assistant:workbuddy, at: 2026-10-18T22:29:10+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/communication-protocol.md
  - predicate: depends-on
    target: /contracts/openapi.yaml
  - predicate: related-to
    target: /docs/decisions/0002-closed-loop-layering.md
---

# ADR-0004 串口契约 v2 已成形——补「不可知状态」红线与取消语义

## 背景

用「组件之间必须有明确契约」这条判据复核 `Runtime ↔ ESP32`（边界 B2）的契约完整度。

**复核结论：契约主体已经成形，不是空白。** 已有内容（`communication-protocol.md` §3）：

| 契约要素 | 现状 | 位置 |
| --- | --- | --- |
| 帧格式 | ✅ JSON-Lines，三类消息 + id 回填 | §3.1 |
| 命令集 | ✅ `hello`/`move`/`rotate`/`velocity`/`stop`/`status`/`calib`/`pump`/`gimbal` | §3.2 |
| 心跳 / 看门狗 | ✅ ≥5Hz + 300ms 本地停机 | §3.3 |
| 错误模型 | ✅ `E_BUSY`/`E_RANGE`/`E_STATE`/`E_FW`/`E_HW` | §3.4 |
| 版本协商 | ✅ `hello.proto`，不匹配进降级模式 | §3.5 |
| 超时 / 重试 | ✅ 命令 500ms，运动不重试 | §7 |
| 单位 | ✅ `hello` 声明：**米 / 弧度 / 秒** | §3.2 |
| 单一契约源 | ✅ `contracts/openapi.yaml` + 生成物 | `contracts/` |

真正缺的是**两条红线没有显式写成规矩**（不是没做，是没成文，容易被后来者越过）：

## 决策驱动

- **判据 P2（真相归属）**：同一事实不许两层各存一份；**不可观测的事实不许伪造**。
- **判据 P3（后果归属）**：谁承担后果谁兜底——安全动作的语义必须无歧义。
- **开环现实**：TB6600 开环 + 当前无编码器（ADR-0002 待实现）→「到位 / 物理静止 / 堵转」
  **当下没有权威来源**，是**物理不可观测**，不是「暂时没做」。
- **已有教训**：ADR-0002 已识别「命令不是事实」，本条把它落到契约字段层。

## 考虑的选项

- **A. 契约里提供 `in_position: true` 等字段**（上层方便）：**否决**——开环下只能靠计时器假装，
  堵转时照样返回 true，**错误被静默传播**，上层会写出「发指令 → 等 in_position → 下一步」的错误依赖。
- **B. 不提供这些字段**（上层无从依赖）：**采纳**。等 ADR-0002 编码器闭环落地后，
  「实走步数」才成为可上报的事实，届时以**新 ADR** 引入。
- **C. `stop` 一个命令包打天下**：**否决**——「有序停（走到段边界）」与「急停（立即断脉冲）」
  后果完全不同，混在一个命令里，上层无法表达意图。

## 决定

**契约主体保持现状（已定稿，不重写）**，补两条红线：

1. **不可知状态红线**：契约**不提供**「轴已到位 / 物理静止 / 堵转」三类字段。
   现有 `status` 只报**可观测事实**：模式、步数（应发计数）、限位、电压、固件错误码。
   `E_HW`（含堵转）只能来自**驱动器 ALM 等硬件信号**，不得由软件推断。
   —— 若某字段无法从硬件观测，**宁缺勿假**。
2. **取消语义红线**：`stop` 与 `estop` **语义必须区分**（当前 v2 命令集只有 `stop`）：
   - `stop` = 有序停：**幂等、可抢占、无 id 也执行**（现状，保留）；
   - `estop` = 急停：**立即断脉冲 + 脱机 ENA**，不走加减速，**新增为待实现项**。
   —— 现有 `stop` 的「~20ms 随脉冲循环轮询」延迟对「有序停」够用；急停需要独立的优先路径。

3. **单位口径单一处声明**：以 `hello` 回读为准（**米 / 弧度 / 秒**）。
   上层（Agent）语义换算成米；**板子不懂语义**。禁止在别处另立单位约定（如 mm/s）。

## 后果

- **好**：「不可知不许伪造」有了成文红线，后来者加字段时会被拦；取消语义区分后，
  安全动作与常规停止不再混用；单位口径单点声明，消除换算层隐患。
- **坏**：`estop` 需在固件新增一条最高优先级路径（无 id、绕过发送队列），有实现成本；
  在上层看来「停」有两个命令，需在 MCP 工具面体现（`motion.stop` vs `motion.estop`）。
- **中性**：`pump`/`gimbal` 仍是预留位，不在本次范围。

## 怎么验证

- **红线可自检**：全文检索契约与状态 schema，断言**不存在** `in_position` / `at_target` /
  `is_stalled` 之类字段；`status` 字段全部可追溯到硬件或计数。
- **estop 生效**：装车后断脉冲 + 脱机，实测**不经过加减速**，端到端时延显著小于 `stop`。
- **单位单点**：断言 `hello` 是唯一声明单位处；`calib` 的 `steps_per_m` / `wheelbase_mm`
  与 `hello` 回读一致（ADR-0002 已有回读机制）。
- **契约不漂移**：改契约跑 `npm run contract:check`（项目既有门禁）。

## 相关资料

- [[communication-protocol|分层通信与接口设计]] §3 边界 B2（全文）
- `contracts/openapi.yaml`（唯一契约来源）+ `contracts/generated/*`
- [[0002-closed-loop-layering|ADR-0002]] —— 「命令不是事实」与闭环分层
- [[../architecture|架构设计]] §1.6 判据 P2/P3

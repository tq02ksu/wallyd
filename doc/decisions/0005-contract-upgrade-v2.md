---
title: ADR-0005 契约升级到 v2：补上「可发现的线协议」与模型帧的准入条件
type: project
description: 复核「组件之间必须有明确契约」时发现两处真缺口——板侧线协议（边界 B2）只有散文没有机器可读形状，且绝不进 MCP 工具面；模型帧（边界 B3）完全没有契约。决定：给线协议加机器可读 spec 摘要（生成板侧常量与白盒断言）、把消费面从探针升级为契约、给模型帧定最小 schema 并立「厂商格式不得直通 Agent」红线。
tags: [adr, robot, contract, protocol]
domain: robot
project: macmini-robot
adr_status: proposed
date: 2026-10-18
sources: []
generated: { by: process:copilot, at: 2026-10-20T18:39:24+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/contracts/openapi.yaml
  - predicate: depends-on
    target: /projects/robot/doc/communication-protocol.md
  - predicate: depends-on
    target: /projects/robot/firmware/robot_server_v2.py
  - predicate: depends-on
    target: /projects/robot/doc/decisions/0004-serial-contract-redlines.md
---

# ADR-0005 契约升级到 v2：补上「可发现的线协议」与模型帧的准入条件

## 背景

ADR-0004 复核了边界 B2（`Runtime ↔ ESP32`）并判定「主体已成形」。本条是**再往下一层**的复核：
把项目**真实在跑**的接口逐个点一遍，问「它有没有单一契约源、有没有门禁」。

清点结果（2026-10-18，逐文件读代码得出）：

| # | 接口 | 现状载体 | 机器可读？ | 门禁 |
| --- | --- | --- | --- | --- |
| ① | `openapi.yaml` → MCP 工具面 + TS 类型 | ✅ 单一源 | ✅ | ✅ `contract:check` |
| ② | **板侧线协议**（op / 字段 / 事件） | ⚠️ **只在散文与代码注释里** | ❌ | ❌ **无** |
| ③ | 内部能力名（`motion.*` / `vision.*` / `audio.*`…） | 代码 `register()` | ❌ | ❌ |
| ④ | **模型帧**（`vision.describe` / `vision.find` 返回） | ❌ **代码是唯一规格** | ❌ | ❌ |
| ⑤ | 原生桥 JSON（一行 / NDJSON） | 散文 | ❌ | ❌ |
| ⑥ | 事件名（`task.*` / `speech.*` / `safety.*`…） | 散文 + 门禁常量 | ⚠️ 半 | ⚠️ 半 |

① 已经做到位，是本项目的标杆。**③ 和 ⑤ 是刻意的**（见「考虑的选项」）。真正需要动手的是 ② 和 ④。

### ② 板侧线协议：实际上已经在漂了

`openapi.yaml` 的生成器里有一行：

```js
if ((op.tags ?? []).includes('debug') || op['x-websocket']) continue;   // contracts/tools/generate.mjs
```

边界 B2 的九条 op（`hello` / `move` / `rotate` / `velocity` / `stop` / `status` / `calib` / `pump` / `gimbal`）
**没有任何一条**出现在 `contracts/` 里。它们的事实源分散在四处：

- `communication-protocol.md` §3（散文表格）
- `firmware/robot_server_v2.py` 的 `handle_json()`（真板）
- `src/runtime/robot-runtime.ts` 的 `SimBoard.send()`（仿真板）
- `doc/archive/poc-design.md` / `eval/`（实测记录）

**而且已经漂了。** 三处不一致，都是读代码发现的：

| 漂移点 | `communication-protocol.md` §3.2 | `robot_server_v2.py` | `SimBoard` |
| --- | --- | --- | --- |
| `rotate` 的参数 | `deg` | **`steps`** | **`steps`** |
| `hello.caps` | 未列 | **无 `ena`**（有 op） | 无 `ena`；多了个 **`pump`** |
| `status` 字段 | 「模式、步数、限位、电压、固件错误码」 | **无 `voltage`、无限位**；有 `ena` / `ena_ms` / `hb_age_ms` | 更少 |

第二行同时暴露一件事：**`hello.caps` 这个「板级能力清单」已经名不副实**——`ena` 有 op 却不申报，
`pump` 申报了但只在仿真板成立。**这就是没有机器可读 spec 的代价：没人跑得起来一致性检查。**

### ④ 模型帧：完全没有契约，而且已经开始泄漏厂商格式

`vision.describe` / `vision.find` 是**唯一一处把「模型的话」直接交给 Agent 的接口**，
但它的返回形状只存在于 `robot-runtime.ts` 的 `postModeld()` / `findTarget()` 里：

```ts
return { text: body.choices?.[0]?.message?.content ?? '', model: body.model, grounded: Boolean(image) };
```

没有 schema、没有门禁、没有归属规则。而设计文档里已经承诺了一条纪律——**`grounded=false` 时
「真模型没有像素也会自信地描述一个不存在的画面」，调用方不得当观测**（`communication-protocol.md` §4）。
这条纪律目前**只写在散文里**，契约里没有任何地方强制它。

并且已经开始泄漏：`robot.speak` / `speech.listen` 的返回体里有 `ts_mono_ns`（原生桥的高精度时钟），
`vision.find` 里有 `self_check` / `self_check_text`（同模型自检的中间态）。这些是**桥和模型的自述**，
不该成为 Agent 能依赖的事实。

## 决策驱动

- **判据 P2（真相归属）**：同一事实不许两层各存一份；**不可观测的事实不许伪造**。
  ② 的三处漂移是同一事实三份副本；④ 的 `grounded` 是「这帧有没有像素」这一事实的权威标记。
- **判据 P5（旁路）**：板侧 op 里 `ena` / `pulse` / `pins` / `led` 是**调试旁路**，
  **不进 Agent 工具面**是刻意的、正确的。所以 ② 要补的是**契约可发现性**，不是把它暴露给 Agent。
- **判据 P4（粒度）**：对外只暴露「机器人能做什么」。模型帧若把厂商格式透出去，
  等于把「模型怎么说话」暴露成了能力面的形状。
- **漂移已在发生**：不是「将来可能漂」，是「现在已经三处不一致」，这本身就是决策依据。
- **仓储纪律**：ADR-0004 要求「改契约必须跑 `contract:check`」。②④ 目前**没有可跑的门禁**。

## 考虑的选项

- **A. 把板侧线协议也塞进 `openapi.yaml`。** **否决**——它会经 `generate.mjs` 变成 MCP 工具，
  直接把 `pins` / `pulse` / `ena` 漏进 Agent 工具面，正面违反 P5 + P4。
- **B. 给线协议另立 `contracts/wire-protocol.yaml`**，作为**板侧形状的唯一事实源**，
  但不进 `generate.mjs` 的工具面出口。**采纳**。
- **C. 保持散文 + 代码注释。** **否决**——已证明会漂。
- **D. 把内部能力名也导出成契约清单。** **暂缓**——它是 `/v1/debug/*` 旁路的一部分，
  且 `motion.move` / `camera.capture` 这类名字**由 `openapi.yaml` 的 `operationId` 映射而来**，
  目前靠命名巧合一致。记成待办，不在本次范围。
- **E. 给模型帧也立 `contracts/model-frames.yaml`，并在 `vision.*` 返回上加 `grounded` 断言。** **采纳**。
- **F. 原生桥的 JSON 也契约化。** **暂缓**——桥是 `spawn` 的子进程边界，
  形状简单（一行 JSON / NDJSON，`{ok, data}` / `{ev, ...}`），散文足够；且**只有 robotd 一个调用方**。
  真扩到两个以上调用方时再补。

## 决定

**契约升级到 v2：给两条「只有散文」的边界补上机器可读形状 + 可跑门禁。**
`openapi.yaml` 与边界 B1 的做法**不动**（它已经是标杆）。

1. **板侧线协议独立成 `contracts/wire-protocol.yaml`**，作为边界 B2 的**唯一事实源**。
   - 内容：9 条 op 的参数/返回字段、6 类事件、错误码、`hello.caps` 的**权威清单**。
   - **`hello.caps` 正名为「可发现性标记」**：由 spec 生成，逐条标注 `agent_visible`（能否经
     `/v1/debug/serial` 触达）与 `debug_bypass`（是否 P5 旁路）。
   - 它**不进 `generate.mjs` 的 MCP 工具面出口**——边界 B2 从设计上就不该出现在 Agent 眼里。
   - **板侧常量从它生成**：`MAX_RATE` / `HEARTBEAT_TIMEOUT_MS` / `CHUNK_MS` / `DT_CAP_MS` /
     `POLL_EVERY_STEPS` / `TICK_MS` 这些实测拍出来的数字，目前是固件里的散落常量，
     升级为 spec 中的**一个区块**，固件侧从生成物取值。
   - **门禁**：`npm run contract:check` 扩一条——**白盒断言**。SimBoard 是「固件行为的可执行规格」，
     所以用 `robotd:sim` 起一个仿真板，跑一遍 spec 里每条 op，断言
     「应答字段 ⊇ spec 声明字段」且「无未声明字段」。这是**不需要真机**就能挡漂移的办法。

2. **模型帧独立成 `contracts/model-frames.yaml`**，给 `vision.describe` / `vision.find` 定最小 schema。
   - **红线**：**厂商格式不得直通 Agent**。模型原始输出只能作为 `raw` 字段（带 `model` / `elapsed_ms`
     与「这是模型的说法、不是观测」的显式标注），**不得成为能力面的形状**。
   - `grounded` 升格为契约字段，且在**能力面 `inputSchema` 级**表达（在 `vision.describe` /
     `vision.find` 的返回里强制存在）——把散文纪律变成可断言事实。
   - **同时收口已经泄漏的帧**：`ts_mono_ns`（原生桥时钟）与 `self_check_text`（模型自检中间态）
     标为 `internal`，不允许经 `/v1/debug/call` 透给 Agent。

3. **补写两条成文规矩**（与 ADR-0004 同风格，不新增机制）：
   - **`hello.caps` 精确语义**：它声明的是「**能被 `/v1/debug/serial` 触达的 op**」，
     **不是**「能力面」（那是 `robot.capabilities`）。两者不可互相替换。
   - **`velocity` 的双身份**：它既是**心跳**（喂狗、不承载运动意图）又是**连续控制通道**
     （`v` / `w` 字段）。契约必须说清「哪种用途下看得懂哪个字段」，
     避免 host 以为发了 `velocity` 就等于下了速度指令。

## 后果

- **好**：两条边界从「散文」升级为「可发现 + 可断言」，漂移有门禁挡；`hello.caps` 名实相符；
  `grounded` 这条安全纪律从「写在文档里」变成「跑得起来」；板侧常量的实测值有了单一住处。
- **坏**：多两个 spec 文件要维护；`contract:check` 从「① 的一致性检查」扩成「① 一致性 + ② 白盒断言」，
  跑得久一点；SimBoard 要跟着 spec 补齐（它目前缺 `ena` 等 op 的完整复刻）。
- **中性**：③（内部能力名）与 ⑥（事件名）本次不动——③ 待 robotd 冒烟脚本立起来时再收口
  （见「怎么验证」第 4 条），⑥ 已有 `V1_SUPPORTED_TYPES` 常量做半门禁。原生桥（⑤）保持散文。

## 怎么验证

- **漂移门禁**：`npm run contract:check` 通过 = 生成物一致 + 白盒断言通过。故意在 SimBoard 里
  加一个未声明字段，断言必须失败。
- **② 不再漂**：断言 `wire-protocol.yaml` 是 `hello` / `move` / `rotate` / `status` 的
  **唯一**字段来源；固件与 SimBoard 的常量与 spec 生成物逐字一致。
- **④ 红线可检**：断言 `vision.describe` / `vision.find` 的返回**必带 `grounded`**；
  断言 Agent 能看到的字段里**不存在** `ts_mono_ns` / `self_check_text` 这类 `internal` 标记项。
- **③ 的缺口记着**：断言 robotd 冒烟脚本引用的能力名**全部**能在 `/v1/debug/capabilities` 找到
  （agentd 冒烟已有 `gateCall('motion.move')` 这类引用，缺的就是这条断言）。
- **真机核对**：装车后跑一遍 spec 里的 op，断言真板应答与 spec 一致——白盒断言只能保证仿真板，
  真机一致性要单独过一次（这一条依赖装车，与 ADR-0002 的标定同批）。

## 相关资料

- `contracts/openapi.yaml` + `contracts/tools/check.mjs`（现有标杆与门禁）
- [[communication-protocol|分层通信与接口设计]] §3（边界 B2 散文）、§4（边界 B3 与 `grounded` 承诺）
- `firmware/robot_server_v2.py`（`handle_json`；`DRIVERS_PRESENT` 通过 `hello` 自报）
- `src/runtime/robot-runtime.ts`（`SimBoard.send`、`postModeld`、`findTarget`）
- [[0004-serial-contract-redlines|ADR-0004]] —— 契约主体已成形；本条处理的是**再下一层**的可发现性
- [[0002-closed-loop-layering|ADR-0002]] —— 板侧「应发 vs 实走」上报（`odometry` 已在 `openapi.yaml`）

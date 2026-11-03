---
title: ADR-0007 agentd / robotd 模块边界分离——独立契约、公开接口与审批适配器归属
type: project
description: agentd 独立定义面板业务契约，与 robotd 仅通过公开接口交互；带审批策略的 robot-mcp 适配器归 agentd，身体能力、状态与执行前授权校验归 robotd。
tags: [adr, robot, architecture, boundary, contract]
domain: robot
project: macmini-robot
adr_status: accepted
date: 2026-10-18
sources: []
generated: { by: assistant:workbuddy, at: 2026-10-18T23:40:00+08:00 }
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: relates-to
    target: /projects/robot/doc/decisions/0006-robotd-event-driven-core.md
  - predicate: depends-on
    target: /projects/robot/contracts/openapi.yaml
  - predicate: relates-to
    target: /projects/robot/src/agentd.ts
---

# ADR-0007 agentd / robotd 模块边界分离

> 2026-10-23：用户确认以下边界决策，本稿修订后接受。
> **accepted 表示决策已确认，不表示重构已完成。** 下述 POC 证据保留为迁移基线，
> 后续改变已接受的决策须新建 ADR。
>
> **2026-10-23 路径变更说明（不改本 ADR 的决策内容）**：文中出现的 `src/agentd.ts`、
> `src/agentd/robot-mcp.ts` 等路径是**当时代码现状的证据**，这些文件已随 POC 删除。
> agentd 现已独立成目录：代码 `agentd/src/`、界面 `agentd/ui/`、
> 契约 `agentd/contracts/`（原 `contracts/agentd/`）、测试 `agentd/tests/`。
> 本文引用的路径按历史原文保留，阅读时以 `agentd/` 下的实际结构为准。

## 背景

用户的问题里有一句话是关键：「现在是一个 agentd，一个是 robotd 这两个模块，**基础能力集成在
robotd 里面**」。这句话描述的现状是**正确的**；但读代码发现，这个「正确」目前是靠**借用**维持的，
不是靠**边界**维持的。以下三处记录现状；其中读取公开状态本身是合理行为，
问题在于运行时文件耦合、面板契约缺失及适配器职责不明确：

### 证据 1：agentd 读 robotd 的契约生成物

```ts
// src/agentd.ts:78
const MCP_TOOLS_FILE = path.resolve(HERE, '..', 'contracts', 'generated', 'mcp-tools.json');
const mcpTools: any[] = JSON.parse(fs.readFileSync(MCP_TOOLS_FILE, 'utf8'));
```

`mcp-tools.json` 是 **robotd 的** `contracts/tools/generate.mjs` 从 **robotd 的**
`contracts/openapi.yaml` 生成的。agentd 拿它来做两件事：

- `probeRobotd()` —— 用 `capabilities: mcpTools.length` 报「身体有几个能力」（这个用法是**合理**的：agentd 想知道对端能力）
- `fetchToolFace()` —— 用 `mcpTools.map(...)` 直接构造 `GET /api/tools` 的返回，
  即「**Agent 有什么权限**」这张表（`agentd.ts:97`）

问题不是面板不能展示 robotd 能力，而是该路由缺少 agentd 自己的契约，且在运行时读取
robotd 部署目录的生成文件。能力定义可以来自 robotd 的公开接口，面板投影则由 agentd
定义，包含可用性、来源与应用侧权限；不能把本地静态文件数量当作实时能力发现。

### 证据 2：`robot-mcp.ts` 也在读同一份文件

```ts
// src/robot-mcp.ts:22
const TOOLS_FILE = path.resolve(HERE, '..', 'contracts', 'generated', 'mcp-tools.json');
```

`robot-mcp.ts` 是 agentd **spawn 起来的子进程**（`agentd.ts:182`
`const mcpArgs = [path.join(HERE, 'robot-mcp.ts'), '--url', CFG.robotd]`），
它清一色是「agentd 侧的代码」——却住在 `src/` 根目录、和 `robotd.ts` / `robot-mcp.ts` / `agentd.ts` 平级，
且**读 robotd 的契约**。这是第一个「进程归属」含糊点：**robot-mcp 是谁的一部分？**

### 证据 3：agentd 用 robotd 的 HTTP 端点构造自己的状态视图

```ts
// src/agentd.ts:83
const st = await fetch(`${CFG.robotd}/v1/robot/state`).then((r) => r.json());
robotdInfo = { url: CFG.robotd, ok: true, mode: st.mode, firmware: st.firmware, ... };
```

agentd 的 `snapshot()` 将这些字段展示给面板。**调用公开状态接口、选取或转述字段都合理**，
不要求为了“独立”而改名。目标是明确来源、观测时间、新鲜度和断线语义，
不把该副本变成第二份可写 RobotState，也不把服务可达等同于身体安全。

### 这三个证据合起来说明什么

需要区分运行时接口边界与构建期公开契约依赖：前者不能通过读取对端文件绕过，
后者是正常客户端开发方式。仅新增网络发现仍不能代替 agentd 自身面板契约，
还需明确适配器以及审批与执行检查各自归属。

## 决策驱动

- **真相归属**：身体能力和状态归 robotd；任务编排、会话、模型配置、审批和事件投影归 agentd。
- **运行时隔离**：agentd 不读取 robotd 内部代码、数据库或运行文件，不直接接触串口。
- **独立演进**：robotd 内部重构不影响 agentd；公开契约变化通过版本兼容与契约测试管理，
  不承诺任意 API 变化都不影响客户端。
- **职责完整**：agentd 决定审批与审计，robotd 执行前校验授权；两者不能相互替代。

## 考虑的选项

- **A. 维持现状**（agentd 继续读 robotd 的 `mcp-tools.json`）。
  - **否决**。运行时依赖对端文件布局与生成物版本，不能独立部署，
    且无法由静态清单证明当前服务实际可用的能力。
- **B. 让 agentd 在启动时通过**网络**从 robotd 拉工具面**（`GET /v1/...` 或 MCP `tools/list`）。
  - **必要但不充分**。它消除运行时文件耦合，但单独采用仍未定义面板契约和适配器归属。
    面板可以复用公开能力字段，另需由 agentd 声明应用权限与观测语义。
- **C. 独立面板契约 + 公开接口交互 + 审批适配器归 agentd。**
  结合 B 的运行时发现，明确双方权威与构建期契约依赖。
  - **采纳**。

## 决定

选择 **C**。四条具体规定：

### 1. 契约独立拥有，不禁止正常客户端依赖

```
contracts/
  openapi.yaml                 ← robotd 的契约（现状保留，不动）
  generated/                   ← robotd 的生成物（现状保留，不动）
  agentd/
    openapi.yaml               ← 【新增】agentd 的对外契约（面板面）
    generated/                 ← 【新增】agentd 的生成物
  tools/                       ← 生成器（改造成可被两个契约复用）
```

agentd 及其适配器**运行时不得读取 robotd 部署目录中的契约生成物、内部代码、数据库或
运行文件**。能力发现与调用通过 robotd 公开接口完成；发现入口尚未具备时先补契约与实现，
不得退回文件读取。

**构建期允许使用版本化的公开 robotd 契约生成客户端类型/SDK**，生成客户端随 agentd
自身发布，不依赖对端文件布局，也不代替运行时能力/可用性检查。共享生成工具可以复用，
但各契约及其生成物独立维护与校验。

### 2. `robot-mcp.ts` 的归属必须显式化

选择 **C1：带有 agentd 审批策略的 `robot-mcp` 适配器归 agentd**，
目标位置 `src/agentd/robot-mcp.ts`，生命周期由 agentd 管理。它负责发现/适配公开能力、
转交审批请求、携带授权调用 robotd，不持有身体能力实现。

C2（将整个现有适配器归 robotd）不采纳，因为会把应用侧审批策略带入身体服务。
这不禁止 robotd 提供其自己的通用 MCP 服务端；该服务端只承载 robotd 公开能力，
不接管 agentd 的会话或审批结论。

迁移不仅是移动文件：需消除生成物运行时读取，补齐公开发现、审批与授权协议及兼容测试。

### 3. agentd 的对外契约独立定义，且**表达 agentd 的东西**

`contracts/agentd/openapi.yaml` 定义 agentd 的面板业务：会话、任务、模型配置、
审批观测和历史事件。`/api/tools` 表达 Agent 可用能力与应用权限投影，可引用对端公开字段，
但不把本地 robotd 静态文件作为实时事实。

POC 已有 health/state/tools/runs/run/stop/approvals/transcript 等路由；
迁移时逐项登记保留、适配或替换，不把补契约等同于冻结所有 POC 路由。
`POST /api/stop` 是中断编排，不冒充 robotd 的身体停止。
具体业务设计和任务见 [agentd 详细设计](../spec/agentd-functional-design.md)
与 [开发计划](../spec/agentd-development-plan.md)。

**正常审批是语音确认，面板只观察**：agentd 持久化请求与审计，通过 robotd 系统播报复述，
收到明确、匹配的语音确认后签发短时、一次性、capability 与参数绑定的授权；
robotd 执行前校验签发者、参数、有效期与单次消费状态。语音确认不等于声纹身份认证。
超时、歧义、取消、不可达、存储失败均拒绝。

POC 的挂起式 `POST /api/approvals`、默认 120 秒超时及面板结论回填是历史实现，
不是生产交互定案。目标内部审批通道须显式认证，与浏览器只读接口隔离；
测试人工批准不能成为正常业务入口，具体等待与超时语义在契约中定义。

### 4. 运行时只走公开契约，不限制合法 URL 数量

| 相遇处 | 方向 | 载体 | agentd 侧不得做的事 |
| --- | --- | --- | --- |
| 能力发现与调用 | agentd → robotd | 公开 MCP / HTTP，由客户端适配器承接 | 不得依赖对端文件或调用调试硬件旁路 |
| 状态、任务与事件 | 双向请求/订阅 | 公开 State、Task 查询/取消及 WS | 不得形成第二份可写身体状态；观测须标来源与新鲜度 |
| 审批协作与授权 | 双向 | 显式受保护的公开进程间协议 | 不得绕过 agentd 审批，也不得取消 robotd 执行前检查 |

这里的“公开”指有契约、可独立消费的接口，不意味着匿名开放。
新增接口必须先入所属服务的契约；合法任务查询、取消和审批协作不受“只能两个 URL”限制。
robotd 内部导航、控制循环和串口所有权不因本决策改变。

## 后果

- **好**：实施后两服务可独立部署与演进；面板业务有明确契约；适配器与审批/执行责任清晰。
- **坏**：需要独立契约门禁、运行时发现及授权协议，不能靠移动文件完成迁移。
- **中性**：保留正常的状态转述与构建期契约依赖；观测字段需补充新鲜度语义。
  ADR-0006 仍是独立提案，接受本条不等于接受其内部事件循环方案。

## 怎么验证

- **独立运行**：移除 robotd 源码/生成文件的运行时挂载后，agentd 仍可经公开接口发现与调用能力。
- **客户端兼容**：构建依赖固定公开契约版本；测试服务端版本不兼容/能力不可用的明确错误。
- **双契约门禁**：`contract:check` 覆盖两套契约及生成物；面板 API 不误投影为模型工具。
- **观测归属**：State/WS 断线与重连后来源、新鲜度及未知状态正确；agentd 不能写回自己的身体副本。
- **审批闭环**：正常 UI 无批准写入口；语音确认绑定动作；robotd 拒绝缺失、改参、过期或复用授权。
- **合法接口覆盖**：能力调用、任务查询/取消和审批协作均经所属契约；不按 URL 数量做门禁。

以上为后续实施验收要求，本次接受决策不声称这些检查已通过。

## 相关资料

- [[0006-robotd-event-driven-core|ADR-0006]] —— robotd 内核提案（proposed，非本条接受范围）
- [[communication-protocol|分层通信与接口设计]] §0（契约只在进程边界）、§2 边界 A
- [[architecture|架构设计]] §6.3（为什么切三个进程）、§6.5（进程边界决策）
- `src/agentd.ts` —— 混线的三处证据
- `contracts/tools/generate.mjs` —— 生成器已支持 `CONTRACT_OPENAPI_YAML` / `CONTRACT_OUT_DIR` 覆盖

# agentd（TypeScript）

Mac mini 移动机器人的**大脑与日常界面**：会话与任务编排、事件时间线、模型配置、身体观测、停止旁路。

边界依据 [ADR-0007](../docs/decisions/0007-agentd-robotd-boundary.md)：agentd 与 robotd **只通过公开 HTTP/WS 接口交互**，
不 import 对方源码、不共享内存、不读对方内部结构。

> **当前进度**：M1（契约与持久化内核）+ M2（观测与编排骨架）完成。
> 已实现：独立契约与事件白名单、SQLite 持久化、任务全链路与幂等、事件游标与 WS 实时推送、
> 模型配置的 revision / 只写凭证 / 验证门槛、身体观测与故障降级、停止旁路、日常界面。
> **未实现**：A10 受管 Harness（app-server 生命周期）、A13 语音审批与一次性授权。
> 因此 A11/A12/A14 只到「编排骨架 + 停止旁路」，**尚不具备完整安全动作闭环**。
> 逐项状态见 [开发计划](../docs/spec/agentd-development-plan.md)。

## 装与跑

```bash
cd <wallyd-root>/agentd
npm install          # 唯一依赖：@openai/codex-sdk（含平台原生二进制，约 360 MB）
npm start -- --robotd http://127.0.0.1:8787 --port 8791
# 或从仓库根：npm run agentd
```

**依赖说明**：agentd 自身代码只用 Node 标准库（含 `node:sqlite`），唯一的 npm 依赖是
`@openai/codex-sdk`——它是 Codex app-server 的客户端。注意它**不是纯 JS 库**：
包里带各平台原生二进制（`@openai/codex-darwin-arm64` 等），SDK 内部仍然 `spawn` 子进程走 JSON-RPC。
进程边界没有消失，只是二进制分发交给了 npm。

`--experimental-strip-types` 的**硬限制**：不支持 TypeScript 参数属性
（`constructor(private x)`），字段必须显式声明。写了会直接抛语法错误。

## Codex 隔离（重要）

Codex 默认读写 `~/.codex`。**本项目的 agentd 不得碰主机的这个目录**——那里有真实会话历史。

隔离手段是把 `CODEX_HOME` 指向 agentd 专属目录，并且启动子进程时**显式传 `env`**
（SDK 一旦收到 `env` 就不继承 `process.env`）。

落点由 `src/agentd/paths.ts` 统一决定，默认：

```
~/Library/Application Support/robot/agentd/codex-home     # macOS
```

为什么是这里，而不是别处：

- **不是 `work/`**：那儿随时可清空，而这里是**会话历史**——清掉等于 `resumeThread` 全部失联；
- **不是 `~/Library/Caches`**：系统在磁盘紧张时会回收 Caches，恢复会话会**静默失败**；
- **不与主机共用 `~/.codex`**：agentd 是独立进程，共用等于把两边的历史搅在一起。

可用 `AGENTD_CODEX_HOME` 覆盖。上面这个路径会如实出现在 `/api/state` 的
`brain.harness.codex_home`，并显示在总览页「会话沙箱」一行——**给用户核对用的**，
不是内部细节。

`npm run test:codex` 是这条约束的取证脚本，它断言：

- 沙箱目录独立于 `~/.codex`，且不在 git 工作区内；
- 落在 Application Support，且与 `~/Library/Caches/Codex` **不重合**；
- 真启动二进制，让它**自报 home** 指向 agentd 专属目录（这是唯一可信的判据——
  `startThread()` 不 spawn，目录空不代表隔离失效）；
- 二进制读不到主机凭证；
- 跑完后主机 `~/.codex` **没有新增/删除任何文件**。

> 探针**不删沙箱目录**。它是会话历史的存放处，不是缓存。
>
> 快照只比**文件集合**，不比「最新 mtime」。实测观察到主机上另有常驻 Codex 进程
> 持续写 `~/.codex/logs_2.sqlite-wal`，拿 mtime 当判据会把别人的正常写入误判成自己的污染。

有 `CODEX_API_KEY` / `OPENAI_API_KEY` 时探针还会跑一次真实流式 turn；没有则跳过且不判失败。

## 测试

五层，与 robotd 的 `tests/{unit,contract,integration}` 对应：

| 命令 | 层 | 需要 robotd？ |
| --- | --- | --- |
| `npm run typecheck` | **实现类型 == 生成物类型**（`tsc --noEmit`） | 否 |
| `npm run test:unit` | 纯函数与存储：事务原子性、安全边界、编排状态机 | 否 |
| `npm run test:contract` | **实现 == 契约**（路由表、WS 白名单、事件白名单） | 否 |
| `npm run test:codex` | Codex 可用性与**隔离取证**（见下节） | 否 |
| `npm run test:live` | `RobotdClient` 对真 sim robotd | **是** |
| `npm run test:e2e` | 真 agentd + 真 SQLite + 真 WS 全链路 | **是** |

```bash
npm test                 # typecheck + unit + contract，离线可跑
# 需要另一进程先起 robotd：npm run robotd:sim（在仓库根）
npm run test:live
npm run test:e2e
```

连不上 robotd 时 e2e **直接判失败**并提示起服务，不会静默跳过身体断言。
确实要测离线降级路径时，显式设 `E2E_ALLOW_OFFLINE=1`。

## 契约

契约随本目录走（`contracts/`），生成工具在仓库根 `contracts/tools/`（`npm run contract:agentd`）。

**三道门禁，各守一段**：

| 门禁 | 证明什么 | 漏掉它会怎样 |
| --- | --- | --- |
| `npm run contract:check`（仓库根） | 生成物 == 契约 | 手改了 `openapi.yaml` 忘了重新生成 |
| `npm run test:contract`（这里） | 实现 == 契约（路由/事件/WS） | 代码里加了端点，契约没加 |
| `npm run typecheck`（这里） | 实现类型 == 生成物类型 | 响应体字段静默漂移 |

前两道是结构层面的（有没有这条路由、有没有这个事件）。第三道管**形状**。
实现里凡是「自己构造、直接进响应体」的类型都从契约派生，不手抄镜像：

| 实现类型 | 派生自 |
| --- | --- |
| `overview.ts` `HarnessInfo` | `Required<components['schemas']['HarnessStatus']>` |
| `overview.ts` `Issue` | `components['schemas']['Issue']`（`severity` 用 `NonNullable` 收窄） |
| `events.ts` `EventView` / `Severity` | `components['schemas']['EventView']` |

把某一条改回手写 interface，`contract:check` 会**明确报错**（它检查这几个派生声明还在不在），
不会让守卫悄悄消失。当前覆盖 3 项；其余服务端内部行（`*Row` / `*Options`）不对应 schema，不硬绑。

> 为什么必须有第三道：契约给 `EventView` 加一个必填字段时，路由断言全绿——路由没变。
> 只有类型检查能发现 `renderEvent()` 那个返回对象少了字段。
>
> **兼容性语义**（已验证）：契约**加必填**字段而实现没跟 → tsc 红；契约**加可选**字段 → 放行。
> 后者是合法的向前兼容演进，不该报警。

**一个容易踩的坑**：OpenAPI 里 `type: object` 不写 `additionalProperties` 时，
`openapi-typescript` 会生成 `Record<string, never>`（= 只能是空对象）。`EventView.data`
本来要放任意脱敏证据键值，缺了这一行会让实现里每一次赋值都被 tsc 判错。已补上
`additionalProperties: true`。

## 硬约束（改代码前先读）

这些不是风格偏好，是安全模型的一部分：

1. **面板面不投影为模型工具**：本目录的 20 个端点一条都不进 Harness/模型工具面。
2. **正常界面没有批准入口**：`GET /api/approvals` 只读；批准只来自语音确认通道（A13 未实现）。
3. **停止不依赖 agentd**：界面直达 robotd 的 `/v1/robot/stop`，agentd 挂了也能停。
4. **事件类型必须先登记**：未登记类型 `EventLog.emit` **抛错**，不静默丢弃、不直通。
5. **恢复标志由登记表声明**：`is_recovery` 是显式字段，**不得按类型名后缀猜**——
   `daemon.recovered` 名字里有 recovered，语义却是「上次没跑完」的告警。
6. **终态只有 `run.finished` 一条**：五种结果靠 `outcome` 参数区分，不得新造 `run.succeeded` 等类型。
   （`run.cancelled` 是「取消这个动作」，不是终态事件。）
7. **不知道就是不知道**：`unknown` / `null` / `unimplemented` 是一等状态，电量没上报就报未知，不编造。
8. **`outcome_unknown` 不自动重试**：工具已发出但没回结果时，物理动作可能已经发生。
9. **凭证只写不读**：`credential_ref` 指向内存中的 vault，永不落盘、永不回显。
10. **存储不可写即 fail-closed**：不假装成功，直接拒绝新的写动作。

## 目录

```text
agentd/
  package.json        # 独立清单；运行期只有一个依赖（@openai/codex-sdk）
  tsconfig.json       # 只做类型检查（noEmit），守「实现类型 == 生成物」
  contracts/
    openapi.yaml      # 20 端点 / 33 schema；三条硬约束写在 description 里
    events.json       # 28 个事件类型，每条带确定性中文模板与 is_recovery
    generated/        # 生成物：openapi.json / api-endpoints.json / events.json / agentd-types.ts
  src/agentd/
    cli.ts            # 入口：参数解析、信号关闭（无 --host，0.0.0.0 不可达）
    service.ts        # 装配：store→events→runs/models/overview→router→listen
    http.ts           # 路由、请求校验、Host/Origin/CSRF 门禁、body 上限、静态托管
    ws.ts             # RFC6455 握手与帧、心跳、WS_PATHS 白名单、LiveHub
    store.ts          # node:sqlite，user_version 迁移，事务，可写探测
    events.ts         # 事件白名单、模板渲染、游标编解码、查询
    runs.ts           # 会话/任务状态机、幂等、启动对账、取消
    models.ts         # 模型配置、凭证 vault、指纹失效、7 项验证
    overview.ts       # 身体观测（含新鲜度与降级）、问题聚合与排序
    paths.ts          # CODEX_HOME / 数据目录的唯一决定处
    robotd-client.ts  # 唯一与 robotd 通信的地方
  ui/                 # 原生 ESM + CSS，无构建工具，由 agentd 同源托管
  tests/
    unit/             # store / runs / http
    contract/         # 实现 == 契约
    integration/      # 对真 robotd 的客户端；codex-probe.mjs（隔离取证）
    e2e/              # 全链路
```

## 运行产物

- 会话历史与 Harness 沙箱：`~/Library/Application Support/robot/agentd/`（**长期数据，别删**）
- 历史库 sqlite：`work/agentd*/`（已 gitignore，可清）

**本目录下不应出现任何 sqlite/log**——出现了说明某个脚本的落点写错了。

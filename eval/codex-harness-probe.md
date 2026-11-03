---
title: Codex app-server 接入取证（A01）
type: project
description: 确认 @openai/codex-sdk 能否作为 agentd 的受管 Harness，以及与主机 ~/.codex 的隔离是否成立。
tags: [eval, robot, agentd, codex, harness]
domain: robot
project: macmini-robot
date: 2026-10-23
---

# Codex app-server 接入取证（A01）

## 结论摘要

| 问题 | 结论 |
| --- | --- |
| 装个 npm 依赖就能接？ | **使用层面是**，但它不是纯 JS 库 |
| 会不会污染主机 `~/.codex`？ | **不会**，`CODEX_HOME` 隔离已实证 |
| 能否锁版本？ | 能，`codexPathOverride` 可指定二进制 |
| 协议要不要自己手写？ | 不用，SDK 已封装；另有官方 JSON Schema 可生成类型 |

## 环境

- 主机：macOS 26.6.2 / arm64，Node 22.22.2
- 主机自带 `codex-cli` **0.159.2**（`/opt/homebrew/bin/codex`），`~/.codex` 约 **2.0 GB**、9764 个文件
- 项目内 npm 版 `@openai/codex-sdk` **0.164.0**，自带 `codex-cli 0.164.0` 二进制

> **版本不一致**：主机 0.159.2 与项目 0.164.0 是两个独立二进制。项目一律用 `codexPathOverride`
> 指向 `node_modules` 内的二进制，不依赖 PATH，避免「本机行为 ≠ 依赖行为」。

## 包结构事实

| 包 | 内容 | 可否 `import` |
| --- | --- | --- |
| `@openai/codex` | 只有 `bin/bin/codex.js`，无 `main`/`exports` | ❌ |
| `@openai/codex-sdk` | `dist/index.js`，导出 `Codex` / `Thread` | ✅ |
| `@openai/codex-darwin-arm64` | 原生二进制（`vendor/aarch64-apple-darwin/bin/codex`） | — |

`@openai/codex-sdk` 的 `dist/index.js` 内含 `import { spawn } from "child_process"`，
并按平台解析 `@openai/codex-{darwin,linux,win32}-*`。

**所以「npm 依赖」只是把二进制分发这件事解决了，进程边界和 JSON-RPC 一点没变。**
ADR 里「由 agentd 拉起、监控、重启、回收」的职责依然在 agentd 侧，SDK 不管崩溃重启。

安装体积：`agentd/node_modules` 约 **361 MB**（主要是原生二进制）。

## SDK 提供的接口（够 A10 用）

```ts
class Codex {
  constructor(options?: CodexOptions);       // codexPathOverride / baseUrl / apiKey / config / env
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
}
class Thread {
  get id(): string | null;
  run(input: Input, opts?: TurnOptions): Promise<Turn>;
  runStreamed(input: Input, opts?: TurnOptions): Promise<StreamedTurn>;
}
type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
type SandboxMode  = "read-only" | "workspace-write" | "danger-full-access";
```

事件里有 `mcp_tool_call`（含 `server` / `tool` / `arguments` / `result` / `error`），
这正是机器人工具面需要的东西。

**注意**：`ApprovalMode` 四档没有一档对应「语音确认」。A13 的审批必须在 agentd 侧自己实现，
SDK 的审批回调只能作为其中一层。

## 隔离取证（核心）

主机 `~/.codex` 有 2 GB 真实会话历史，任何读写都不可接受。

手段：`CODEX_HOME` 指向 `work/codex-probe/codex-home`，且启动子进程时显式传 `env`
（SDK 一旦收到 `env` 就不继承 `process.env`）。

复现：`cd <wallyd-root>/agentd && npm run test:codex`

实测结果：

```
ok   沙箱 CODEX_HOME 独立于主机目录
ok   沙箱 CODEX_HOME 在 work/ 下（已 gitignore）
ok   @openai/codex-sdk 可 import
ok   npm 包自带二进制存在
ok   startThread 返回 Thread 实例
ok   doctor 有输出（退出码非零属正常：它报告了问题）
ok   二进制自报的 home 在沙箱内        ← 自报 ~/workspace/.../codex-probe/codex-home
ok   二进制读不到主机凭证
ok   主机 ~/.codex 没有新增文件
ok   主机 ~/.codex 没有文件被删除
     文件数 1258 → 1258
```

### 取证过程中修正的两个错误判据

这两个都值得记下来，因为它们是「看起来通过、其实没测到」的典型：

1. **「沙箱目录空」≠「隔离失效」**。`startThread()` 只构造对象、**不 spawn**；
   只有真正跑 turn 才会创建会话文件。最初用「沙箱非空」当判据，得出了错误的失败结论。
   正确判据是**真启动一次二进制，让它自报 home**。

2. **不能用「最新 mtime」判断主机目录是否被污染**。实测发现 `~/.codex/logs_2.sqlite-wal`
   被主机上常驻的 Codex 进程（PID 58152 / 58186）**持续写入**，mtime 每秒在变。
   用 mtime 当判据会把别人的正常写入算成自己的污染。
   改为只比**文件集合**（新增/删除）。

3. **主机目录的文件计数会自己波动，不能当判据**。交叉验证时观察到：
   - 不同的 `find` 之间计数在 9764 / 9766 / 9767 / 9768 / 9784 之间跳；
   - 不跑任何探针、静置 30 秒，计数不变；
   - 仅跑一次 `codex doctor`，计数不变但 `md5` 却不同。

   最后一组实验定性了原因：把前后两次文件列表落到临时文件做 `comm` 精确比对，
   **新增 0、消失 0**。也就是说 md5 差异来自两次采样之间被常驻进程插入又删除的写入，
   属于测量噪声，不是探针行为。

   **可靠判据是「跑前跑后精确 diff 文件集合」**，不是计数、不是 mtime。探针内已按此实现。

## 尚未完成

- **流式与中断未实测**：当前环境没有 `CODEX_API_KEY` / `OPENAI_API_KEY`，
  探针跳过真实 turn 且不判失败。A01 要求的「流式、工具调用、中断、线程恢复」四项仍待有凭证时补测。
- **主机凭证未使用**：主机 `~/.codex/config.toml` 里配了 provider 与 token，
  按「不污染、不依赖主机」的要求**没有读取也没有使用**。要用需显式提供环境变量。

## 对 A10 的影响

工作量比预想小：不用手写 JSON-RPC 客户端。剩下的核心是：

1. 生命周期（spawn 由 SDK 做；**重启、回收、僵尸清理仍是我们的**）
2. 事件映射（SDK `ThreadEvent` → agentd 已登记的 28 个事件类型）
3. `outcome` 判定（SDK 的 `turn.completed` **不等于**物理任务成功，这是设计文档特别强调的）

代价：agentd 不再是「零依赖」。这是一个需要明确记录的取舍。

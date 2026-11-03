# robotd（Python）

Mac mini 移动机器人的**身体运行时**。本目录是 [ADR-0009](../doc/decisions/0009-robotd-python-runtime.md)
确定的 Python 新实现；迁移期与旧的 TypeScript POC（[`../src/`](../src/)）并存。

> **当前进度：M0 完成 + M1 工程骨架。**
> 已实现：配置与启动校验、事件归并内核、权威状态、任务表与互斥、能力注册表、生命周期与信号关闭。
> **未实现**：HTTP/WS 传输（R09/R10）、板侧适配与真机串口（R07/R11）、控制隔离（R02）、
> 感知与跟随（R15–R17）、语音（R14）。
> 逐项状态见 [开发计划 §3](../doc/spec/robotd-development-plan.md) 与能力表（`robotd.capabilities`）。

## 装与跑

```bash
cd projects/robot/robotd

# 开发环境（先安装 uv；无需任何硬件）
# 使用本目录 .venv，严格按已提交的 uv.lock 安装依赖
uv sync --locked --extra dev --python 3.11

# 自检：不打开串口、不启子进程、不监听端口
uv run --locked --extra dev python -m robotd check-config --sim
uv run --locked --extra dev python -m robotd health

# 测试
uv run --locked --extra dev python -m pytest tests/unit tests/contract

# 格式检查 / 自动整理（沿用 pyproject.toml 中的 Ruff 配置）
uv run --locked --extra dev ruff format --check src tests
uv run --locked --extra dev ruff format src tests
```

依赖变更后运行 `uv lock` 并提交 `pyproject.toml` 与 `uv.lock`；`.venv` 与工具缓存不提交。
Persona 工程中的 `robot-ci` 工作流对相关 push / PR 与手动触发运行：
Ruff 格式检查、Python 3.11 / 3.14 单元及契约测试、Node 22 契约生成物一致性检查。
这些是 Python 骨架的无硬件门禁，不代表旧 TS POC、HTTP/WS 或真机时序已验收。

`serve` 会真的 bind 回环端口并验证生命周期（收到 SIGINT/SIGTERM 时先走停止路径再退出）。
**传输层尚未接入**，所以 `serve` 现在只证明「能监听、能有序关闭」，不提供可用接口。

## 配置优先级

内置默认 → 环境变量 → 命令行参数。

| 项 | 默认 | 环境变量 |
| --- | --- | --- |
| 监听地址 | `127.0.0.1`（**只允许回环**，`0.0.0.0` 直接拒绝启动） | `ROBOTD_BIND` |
| HTTP 端口 | `8787` | `ROBOTD_HTTP_PORT` |
| 仿真 | 关 | `ROBOTD_SIM` |
| 串口 | `/dev/cu.usbserial-A5069RR4` | `ROBOTD_SERIAL_PORT` |
| modeld | `http://127.0.0.1:8790` | `ROBOTD_MODELD` |
| 运行产物目录 | `<项目根>/work` | `ROBOTD_WORK_DIR` |

## 与旧 TS 实现的关系（硬性）

- **同一个串口只能有一个实际持有者。** 本包与 `npm run robotd` 不得同时连真机。
  迁移完成前，真机一律走旧 TS 实现。
- 对外契约只有一份：[`contracts/openapi.yaml`](../contracts/openapi.yaml)（+ [`contracts/events.json`](../contracts/events.json)）。
  改契约 → `npm run contract:generate` → `npm run contract:check` 必须通过。
- `tests/contract/` 读 `contracts/generated/*.json` 断言「Python 实现 == 契约」，
  与 `contract:check` 的「生成物 == 契约」合起来才闭合。

## 设计约束（改代码前先读）

这几条不是风格偏好，是本项目用真机实测和事故换来的：

1. **状态只有一个写入点**：`core/kernel.py` 的 `_reduce()`。别在 handler / capability 里直接改 `state`。
2. **`mode` 只由 `derive_mode()` 推导**：链路优先于任务。旧 TS 实现把这条抄了五处。
3. **内部时钟不外泄**：`ts_mono_ns` 这类字段只用于进程内排序，`scrub_payload()` 会递归剔除。
4. **不知道就是不知道**：`unknown` / `null` / `unimplemented` 是一等状态。
   电量没接 BMS 就报 `source: unimplemented` 且值为 `null`；编码器没装就 `null`；应发步数不冒充实走。
5. **未实现 ≠ 静默成功**：未就绪的能力报 `503 / E_UNAVAILABLE` 并带原因，不受理后返回虚假完成。
6. **物理动作不自动重试**：超时不代表没执行。
7. **`stop` 是安全旁路**：无审批、幂等、最高优先级；但它**不是**硬件急停，也不代表物理静止。

## 目录

```text
robotd/
  pyproject.toml
  src/robotd/
    __main__.py     # CLI：health / check-config / serve
    app.py          # 装配、生命周期、依赖注入、信号关闭
    config.py       # 配置与启动校验（回环强制）
    capabilities.py # 能力注册表 + 审批门 + 未声明字段拒绝
    core/
      errors.py     # 稳定错误码与 HTTP 映射（不把内部故障伪装成 400）
      types.py      # 公开 DTO / 内部记录 / payload 脱敏
      state.py      # 权威状态 + derive_mode 唯一推导
      kernel.py     # 事件归并、序号、保留日志、订阅、任务表
  tests/
    unit/           # 配置、状态、内核、生命周期
    contract/       # Python 实现 ↔ 契约 一致性
```

## 待决策

**R02（控制隔离与所有权）尚未定案**，因此：

- `core/kernel.py` 只用 `threading.RLock` 保证「同一时刻只有一个写入者」，**不声称任何时序保证**；
- 停止端到端 ≤50ms、看门狗 ≤500ms 等目标**未在此实现中验证**；
- 不要基于「Python 线程 == Node worker」的假设写控制路径。

隔离方案见 [ADR-0010](../doc/decisions/0010-robotd-python-control-isolation.md)（proposed，待确认）。

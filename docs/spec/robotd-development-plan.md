---
title: robotd Python 模块开发计划与任务清单
type: project
description: 按契约、内核、控制隔离、设备迁移、快速感知、跟随闭环与切换验收拆解 Python robotd 的开发任务、依赖和逐项完成标准。
tags: [project, robot, plan, robotd, python]
domain: robot
project: macmini-robot
status: draft
generated: { by: process:copilot-agent, at: 2026-10-22T22:20:35+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/spec/robotd-interface-contract.md
  - predicate: depends-on
    target: /docs/decisions/0009-robotd-python-runtime.md
---

# robotd Python 模块开发计划与任务清单

## 1. 范围与当前基线

本轮交付是**开发计划**，不是 Python 迁移完成声明。下面任务初始均为待开始；完成时勾选
checklist，并在任务表填入实现提交或验收记录。没有证据不得标记完成。

已知基线：

- 现有 TS POC 入口在 `src/robotd.ts`，能力与状态集中在
  [`src/runtime/robot-runtime.ts`](../../src/runtime/robot-runtime.ts)，HTTP/WS 在
  [`src/transport/http-server.ts`](../../src/transport/http-server.ts)。
- 新实现采用 Python，模型进程继续隔离，见 [ADR-0009](../decisions/0009-robotd-python-runtime.md)。
  Python 的控制隔离机制尚未定案，不能把 `asyncio` 或线程当成时序保证。
- [接口契约设计稿](robotd-interface-contract.md)规定目标行为；
  [`contracts/openapi.yaml`](../../contracts/openapi.yaml)仍是机器可读事实源，现有 schema 缺口必须先补。
- 快速检测先接 macOS Vision，不预装 YOLO；跟随不是把检测框直接换算成电机命令，见
  [ADR-0001](../decisions/0001-vision-fast-slow.md)。
- ADR-0006 仍为 proposed；ADR-0007 已于 2026-10-23 接受，明确独立契约、公开接口与审批适配器归属，
  并取消运行时读取对端生成物的旧例外。决策接受不代表实现完成，也不冻结新的进程拓扑。

**本期目标**：可独立安装运行的 Python robotd；完整 v1 公开接口；仿真与设备适配；
异步感知和受限的人物跟随；故障下可靠停止；通过验收后显式切换默认启动路径。

**非本期目标**：SLAM、全局路径规划、自主回充、通用物体检测、YOLO 选型、
ROS 2、硬件急停、重写 agentd、重写 Swift 桥。没有经验证的避障能力前，不宣称可无人看护自主行驶。

## 2. 目标源码布局与依赖纪律

以下是目标布局，**按任务逐步创建有实现的目录，不一次性堆空壳**。

```text
robotd/
  pyproject.toml
  README.md
  src/robotd/
    __init__.py
    __main__.py                # CLI：health / check-config / serve
    app.py                     # 装配、生命周期与依赖注入
    config.py                  # 配置校验（强制回环）
    capabilities.py            # 能力注册表、审批门、未声明字段拒绝
    core/                      # 类型、事件归并、状态、任务、错误
    api/                       # HTTP / WS 与公开投影
    behaviors/                 # follow 等语义行为
    perception/
      detectors/               # macOS Vision；将来按需扩展后端
      tracking.py
    motion/                    # 控制意图、时效、安全停止
    devices/                   # 板侧、相机、音频、原生桥适配
    clients/                   # modeld 等网络客户端
  tests/
    unit/
    contract/                  # Python 实现 ↔ 契约 一致性
    integration/
contracts/                     # 保留现有事实源与生成工具位置
  openapi.yaml                 # HTTP/WS 消息的机器可读源
  events.json                  # 公开事件登记表（R03 新增；OpenAPI 3.0 表达不了 WS payload 变体）
src/                           # 迁移期间保留旧 TS POC
scripts/                       # 复用 Swift 桥，不复制进 Python 包
eval/                          # 版本化的复现方法与结论
work/                          # 日志、抓帧、编译物、测量原始数据
```

- `api` 只做协议转换与调用；`core` 是整体状态唯一写入点，设备与算法提交结果事件。
- 行为消费归一化观测与运动接口，不依赖某个检测器的原始格式。暂不为未实现的 SLAM 建模块。
- 抓帧、模型和重计算不进入控制周期；控制路径的具体隔离、串口所有权与 IPC 在 R02 决定。
- agentd 不导入 Python 内部模块、不读取 robotd 生成文件。公开工具仍由契约投影；
  agentd 侧审批与客户端改造另列协作依赖，不在 robotd 偷建第二套审批系统。
- 新旧运行时可以分别测试，但**同一串口只能有一个实际持有者**，不得同时连接真机。

## 3. 任务总表

优先级：P0 是迁移与安全阻塞项；P1 是本期能力交付项。依赖表示完成前置任务后才可验收；
不代表必须串行编写全部代码。不预估日历工期，先用 M0/M1 的结果确认工作量。

| ID | 阶段 / 任务 | 优先级 | 前置依赖 | 主要落点 / 产出 | 状态 / 证据 |
| --- | --- | --- | --- | --- | --- |
| R01 | M0 现状与 v1 差异清单 | P0 | 无 | 操作/事件/设备迁移矩阵 | **完成**（2026-10-23）：[迁移差异矩阵](robotd-migration-matrix.md) |
| R02 | M0 控制隔离与所有权设计 | P0 | R01 | Python 控制机制 ADR、失效时序 | **候选已提交、待人确认**：[ADR-0010](../decisions/0010-robotd-python-control-isolation.md)（proposed） |
| R03 | M0 补齐机器可读契约 | P0 | R01 | OpenAPI、生成物、契约门禁 | **完成**（2026-10-23）：见 §3.1 证据 |
| R04 | M1 Python 工程与生命周期 | P0 | R02 | 包、配置、启动/关闭、测试入口 | **骨架完成**（2026-10-23）：`robotd/`，93 项测试通过；隔离机制待 R02 确认 |
| R05 | M1 事件归并与权威状态 | P0 | R03、R04 | core 状态、事件序列与错误类型 | **起步**：内核/状态/错误码已实现并测试（`core/`），板侧与设备事件待 R07 |
| R06 | M1 任务与取消语义 | P0 | R05 | 任务表、互斥、终态与 stop 协调 | **部分**：任务表/互斥/终态单次提交已实现；运动取消联动 stop 待 R08 |
| R07 | M1 板侧协议与仿真适配 | P0 | R02、R04 | Board 接口、SimBoard、故障注入 | 待开始 |
| R08 | M1 控制路径与安全停止 | P0 | R05、R06、R07 | 意图时效、优先停止、心跳监管 | 待开始（阻塞于 R02） |
| R09 | M2 HTTP 与 MCP 投影对齐 | P0 | R03、R06、R08 | v1 路由、校验、错误与审批元数据 | 待开始（契约侧 schema 已就绪） |
| R10 | M2 WS 快照与增量同步 | P0 | R03、R05 | 订阅、游标、补发、背压 | 待开始（内核订阅/补发已实现，传输层待做） |
| R11 | M3 真机串口、标定与里程计 | P0 | R07、R08、R09 | 串口、握手、复位恢复与标定 | 待开始 |
| R12 | M3 原生桥与相机采集 | P1 | R04、R05 | 桥生命周期、最新帧、设备状态 | 待开始 |
| R13 | M3 modeld 慢路径客户端 | P1 | R05、R12 | 有界异步推理与有效性标记 | 待开始 |
| R14 | M3 音频与语音接口迁移 | P1 | R06、R09、R10 | ASR/TTS、常听、静音、打断 | 待开始 |
| R15 | M4 Vision 检测与人物跟踪 | P1 | R05、R12 | 归一化检测、track、过期失效 | 待开始 |
| R16 | M4 跟随策略与安全边界 | P0 | R02、R03、R15 | 目标绑定、距离依据、丢失策略与参数 | 待开始（契约已补 follow 目标绑定语义） |
| R17 | M4 受限人物跟随闭环 | P1 | R08、R09、R11、R16 | follow 行为与确定性回放测试 | 待开始 |
| R18 | M5 契约回归与故障矩阵 | P0 | R09–R15、R17 | 自动化回归、边界隔离门禁 | 待开始（契约一致性测试已起步：`robotd/tests/contract/`） |
| R19 | M5 目标机时序与受控实测 | P0 | R11、R18 | stop/看门狗/控制时序证据 | 待开始 |
| R20 | M5 启动切换与交付文档 | P0 | R19 | 显式切换、回退步骤、运行手册 | 待开始 |

### 3.1 R03 完成证据（2026-10-23）

| 改动 | 位置 | 验收 |
| --- | --- | --- |
| `RobotState` 全字段收紧：`event_seq` 游标、`pose`（米/弧度/valid）、`devices` 枚举、`battery`（unimplemented 契约化）、`odometry`（应发≠实走） | `contracts/openapi.yaml` | `contract:check` 语义断言 `RobotState.required 含 event_seq` |
| `Task.state` 补 `accepted`；`Task.error` 从自由字符串改为稳定码对象；新增 `exclusivity`（motion/soft） | 同上 | 断言 `TaskState.enum` 五个值齐全 |
| 统一错误码表 `x-robotd-errors`（17 个）与 HTTP 映射（不再把内部故障压成 400） | 同上 | `test_every_error_code_in_contract_is_known_to_implementation` |
| WS 消息 schema：`hello`（含 `instance_id`）、`subscription.accepted`、`state.snapshot`、`event` 封套、`resync_required`、`pong`，以及客户端 `subscribe`/`unsubscribe`/`ping` | 同上 `components.schemas.Ws*` | `generate.mjs` 要求 `WsEvent.required` 与登记表 envelope 一致 |
| 事件登记表（25 个公开事件 + payload 字段 + 必填 + 禁列字段 + 保留未实现类别 + debug 排除项） | `contracts/events.json` → `generated/robotd-events.json` | 断言禁列字段（`ts_mono_ns` 等）不出现在任何事件 payload；`board.*` 不进公开面 |
| servers 端口 8765 → 8787 并注明「端口以运行时配置为准」 | `contracts/openapi.yaml` | 断言不含 `0.0.0.0` |
| 生成器降级：无 `node_modules` 时写出确定性说明而非静默跳过 | `contracts/tools/generate.mjs` | 生成物四个文件一致性 |
| 校验器升级为「4 个生成物 + 语义断言 + OpenAPI 3.0 合法性实跑」 | `contracts/tools/check.mjs` | `npm run contract:check` → `OK` |
| 旧 TS 实现回归（契约变更后必须验证，否则文档非法会让全部路由 404） | 见迁移矩阵 §6.1 | health/state/calibration/stop/404 均正常 |

**未在本轮补齐（有意留到对应任务）**：

- `robot_stop` 是否连带取消语音任务——契约已用 `x-cancels: [motion, speech]` **显式记录现状语义**，
  但「这是否是目标语义」仍需 R06 确认（见迁移矩阵 §8 待确认第 1 条）。
- OpenAPI 3.0 无法表达 WS 事件的 payload 变体，故用独立 `events.json`；`version` 与 OpenAPI 共同维护。

## 4. 各任务 checklist

### R01 — 现状与迁移差异

- [x] 逐项登记 v1 operationId、输入输出、审批属性、当前实现、目标行为及测试位置。（矩阵 §1）
- [x] 登记公开事件、内部事件、调试旁路、原生桥与板侧依赖；区分“可复用”“需迁移”“未实现”。（矩阵 §2/§5）
- [x] 明确旧 follow 的“走走看看”实现不是稳定人物跟踪；不将旧行为未经验证直接迁移。（矩阵 §4.1）
- [x] 为每个差异绑定后续任务；记录契约设计稿与旧实现冲突，避免只复制 TS 行为。（矩阵 §7）
- [x] 记录旧 POC 可复现的仿真基线、启动命令与环境要求，不擅自启动真机运动。（矩阵 §6）

### R02 — Python 控制隔离与所有权

- [x] 对比独立控制进程、线程/原生隔离等可行方案，验证阻塞与失效影响；提交一条新 ADR 供确认。
      → [ADR-0010](../decisions/0010-robotd-python-control-isolation.md)（proposed）。**阻塞/失效的实测验证**在确认后按 R19 做。
- [x] 明确串口唯一持有者、状态唯一归并点、跨隔离边界的消息、确认与超时。（ADR-0010 §1、§3）
- [x] 明确控制存活条件：管理/行为失活或意图过期后不能由独立心跳无限维持运动。（ADR-0010 §2）
- [x] 设计有界队列、停止抢占、普通请求超时、失联降级以及有序关闭的时序图。（ADR-0010 §3、§5）
- [x] 明确控制意图刷新与板侧心跳区别；规定模型/GIL/IPC 阻塞的注入与验证方法。（ADR-0010 §2、验证 1–6）
- [ ] **ADR-0010 经人工确认（adr_status → accepted）**。这是 R02 的真正出口，也是 R08 的前置。

### R03 — 机器可读契约

- [x] 补齐状态、任务、音频、错误、时间戳、坐标系与单位；未声明输入字段默认拒绝。
      → `RobotState`/`Pose`/`Devices`/`Battery`/`Odometry`/`Task`/`AudioState` 全部具名类型；
        `x-robotd-errors` 17 码；未声明字段由 `capabilities.validate_known_fields` 拒绝。
- [x] 补齐 `event_seq`、`instance_id`、WS 控制帧、事件 payload、过滤、恢复与 `resync_required`。
      → `components.schemas.Ws*` 六个服务端消息 + `WsClientMessage`；事件 payload 见 `contracts/events.json`。
- [x] 对齐 follow 的目标表达与不可用错误；明确版本兼容，不静默更改既有参数语义。
      → `FollowRequest` 规定「`target_track_id` 优先、歧义交给调用方澄清」；新增 503/400 响应。
- [x] 保留 operationId 与审批属性，排除 debug/串口原语；不发布未验证的 estop。
      → `check.mjs` 断言硬件原语/estop 黑名单；13 个 HTTP operationId 与审批属性不变。
- [x] 对齐端口配置，运行生成与 `contract:check`；用样例校验请求、响应和事件。
      → servers 8765→8787（并注明以运行时配置为准）；`contract:check` 通过；
        `robotd/tests/contract/test_contract_parity.py` 断言实现与契约一致。

### R04 — 工程与生命周期

- [x] 建立 `robotd/` 可安装包，确认 Python 版本、依赖管理、HTTP/WS 框架及校验方案。
      → `robotd/pyproject.toml`，requires-python `>=3.11`；**运行期依赖为零**（标准库），
        `pyserial` 为可选 extra。HTTP/WS 框架**未选定**：框架选择取决于 R02 的隔离方案，
        标准库 socket 层已能 bind/close（`app.bind_listener`），框架接入留给 R09。
- [x] 提供模块入口、显式 `--sim` 与真机模式、回环绑定、配置优先级和启动校验。
      → `python -m robotd {health,check-config,serve}`；`Config` 强制回环（`0.0.0.0` 启动即拒）；
        优先级 默认→env→argv 有单测覆盖。
- [x] 注入时钟、设备与模型依赖，使单元/仿真测试无需相机、Metal、麦克风或串口。
      → `App(config, clock=..., board=...)`；`tests/helpers.FakeClock/FakeBoard`；93 项测试无硬件运行。
- [x] 实现启动失败与部分初始化清理、信号关闭、子进程回收；关机先走停止路径。
      → `App.start()` 失败即 `_close_components()`；`shutdown()` 先 `request_stop()` 再逆序回收；
        SIGTERM 实测：日志出现「收到信号 SIGTERM，开始有序关闭 / robotd 已关闭」，端口释放。
- [ ] 配置类型检查与测试命令；日志及运行产物落项目 `work/`，不记录凭证或原始音视频。
      **部分完成**：`pytest` 入口在 pyproject（已可跑，93 项通过）；`resolve_work_dir()` 默认
      `<项目根>/work`；`setup_logging(json=)` 只输出时间/级别/来源/消息，不含请求体与音视频。
      **未完成**：类型检查。`mypy` 在本次环境中装不上（install 阶段被中断），且它会引入
      运行期外的额外依赖树；本项不勾选，也不在文档里写「已具备类型检查」。

### R05 — 事件、状态与错误内核

- [ ] 定义内部类型与公开 DTO 的转换；禁止内部单调时钟和模型中间文本泄漏。
- [ ] 实现单点事件归并、唯一状态写入、单点 mode 推导和只读一致性快照。
- [ ] 将快照和 `event_seq` 原子关联；每次启动生成新 `instance_id`，公开事件严格递增。
- [ ] 保留 unknown/null/unimplemented；应发步数不冒充实走位移，板复位使 pose 失效。
- [ ] 建立稳定错误类型和分类映射；测试状态转移、并发输入和错误因果，不依赖字符串猜错误。

### R06 — 任务与取消

- [ ] 实现 accepted/running/终态转换，时间戳、进度、cancelable 与进程内查询。
- [ ] 同时仅允许一个运动任务；竞争请求确定返回 `409/E_BUSY`，不排队隐式执行。
- [ ] 取消、自然结束和故障竞争时仅提交一次终态；终态不再回转。
- [ ] 区分运动任务与语音等非运动任务；明确全局 stop 取消哪些任务，不误杀无关工作。
- [ ] 取消运动必须联动停止确认；测试重复取消、未知 id、stop 抢占及任务超时。

### R07 — 板侧协议与仿真

- [ ] 从现有固件/线协议核实 hello、应答关联、事件、单位、版本与错误，不另造协议。
- [ ] 定义 Board 适配接口及分包/粘包、有界帧长、损坏帧、迟到应答处理。
- [ ] 实现可控时钟的 SimBoard，模拟现有板侧运动、应发计数、心跳超时与复位。
- [ ] 提供断连、无应答、应答延迟、板复位等确定性故障注入，不开放为 Agent 工具。
- [ ] 标明仿真只验证协议与逻辑，不能证明实际位移、硬件到位或真机停止时限。

### R08 — 控制与停止

- [ ] 按 R02 实现隔离机制，普通工作有界，stop 保持最高优先级且幂等。
- [ ] 实现意图截止时间与最新值覆盖；旧意图、旧感知、旧会话结果不能恢复已经停止的运动。
- [ ] 运动期间 host velocity 发送频率目标至少 5 Hz；控制失活不能继续喂板侧心跳。
- [ ] 区分 stop 请求、板侧应答与物理停止；超时明确失败，绝不把应答视为物理静止证明。
- [ ] 注入管理阻塞、控制失活、队列满和取消竞争，验证不会盲重试运动指令且可安全失效。

### R09 — HTTP 与工具面

- [ ] 实现全部 v1 公开路由；先打通 health/state/stop/tasks，再接能力适配器。
- [ ] 由契约约束输入输出与 HTTP 错误码，内部异常归 5xx，不伪装成校验失败。
- [ ] 未配置或未就绪的相机、语音、跟随能力明确报错，不受理后返回虚假完成。
- [ ] 保持 MCP 操作投影与审批元数据；与 agentd 侧明确审批执行责任及网络发现方式。
- [ ] debug 默认关闭且不进入工具面；非回环绑定拒绝或明确禁止。

### R10 — WebSocket 同步

- [ ] 实现 hello、订阅确认、初始快照；在捕获快照游标时开始缓冲，消除订阅竞态。
- [ ] 实现精确/前缀过滤、取消订阅、ping/pong，保证匹配事件有序。
- [ ] 实现有限回放窗口；校验实例与游标，过期/实例变化/无效游标按契约重新同步。
- [ ] 为慢订阅者设有界缓冲与明确断开/重同步语义，不阻塞状态归并和 stop。
- [ ] 测试高并发订阅、重连、过滤造成的序号空缺及快照一致性；不假设每个事件都是状态 patch。

### R11 — 真机串口、标定与里程计

- [ ] 实现串口独占、连接/断连、hello、协议兼容校验及板复位后重新握手。
- [ ] 迁移标定读取、host 更新、板侧应用与持久化语义；部分成功明确报告并禁止使用不一致值运动。
- [ ] 迁移应发步数与里程积分，注明估计来源；真实编码器未接时对应字段保持 null。
- [ ] 板复位/计数回退时终止相关任务、作废 pose，不自动续跑旧任务。
- [ ] 仿真通过后才申请受控真机验证；记录固件、参数、限速和测试条件，不擅自刷固件。

### R12 — 桥与相机

- [ ] 复用现有 Swift 桥，统一子进程启动、NDJSON 解析、stderr、超时与退出状态处理。
- [ ] 按[相机规范](camera-detection.md)区分枚举、可用、实际出帧；授权缺失与长期无帧明确报告。
- [ ] 帧包含标识、采集时间、尺寸与有效性；采用有界最新帧策略，不积压图像。
- [ ] 避免多个消费者重复抢占相机；支持断连恢复，恢复前旧帧失效。
- [ ] 抓帧仅进 `work/`，定义保留上限与清理策略；测试无设备、桥崩溃和无帧。

### R13 — modeld 慢路径

- [ ] 保持独立 modeld，通过配置的本地网络端点调用，不把推理库装进控制内核。
- [ ] 有界并发、超时与取消；晚到结果不得污染已经结束的任务或最新观测。
- [ ] 仅真实提供图像且通过有效性检查的结果可标 grounded；失败不编造视觉结果。
- [ ] 保留公开与内部事件分离；不因增加内部 VLM 功能自动扩大 MCP 工具面。
- [ ] 用慢响应、进程退出和错误输出测试，断言状态查询、stop 和心跳不受推理等待影响。

### R14 — 音频与语音

- [ ] 迁移 audio state/mute/unmute、流式 listen 与 speak 的契约行为，复用现有音频桥。
- [ ] 对齐 utterance/task 关联、partial revision/final、说话结束和错误事件。
- [ ] 保留分句播报、取消与 barge-in 的既有适用语义；明确音频资源冲突策略。
- [ ] 静音期间不产生新的识别结果；缺权限/空音频/桥退出不能伪装为成功听音。
- [ ] 用公开或合成夹具验证接口与打断；语音事件只供 agentd 路由，robotd 不解析通用自然语言命令。

### R15 — 快速检测与跟踪

- [ ] 接 macOS Vision 人体检测，确定所需 Swift 桥扩展；不新增 YOLO 权重或依赖。
- [ ] 归一化检测类别、框坐标、置信度、帧 id 与有效时间；不暴露后端原始结构。
- [ ] 实现跨帧关联、track 生命周期与丢失判定；track id 不当作人物身份。
- [ ] 输出最新有效观测；乱序、过期、重复帧和相机恢复不能延续旧目标身份。
- [ ] 用多人物交叉、遮挡、空画面与无帧夹具验证 ID 切换和失效；在目标机重新测整条链路延迟。

### R16 — 跟随设计与放行条件

- [ ] 明确目标绑定来源，歧义交给 agentd 澄清；不能悄悄切换成画面内另一个人。
- [ ] 确定相对位置/距离的可验证依据与标定方法；单目框大小不直接冒充可靠米制距离。
- [ ] 确定速度/加速度/转向上限、观测截止时间、丢失停止、重新绑定及前向安全边界。
- [ ] 明确无测距/避障条件下允许的受控演示范围；无法满足条件时禁止真机跟随。
- [ ] 将影响接口的变化先回填 R03；新架构决策单独写 ADR，确认后再实现，不在代码中隐藏选型。

### R17 — 跟随闭环

- [ ] 实现目标绑定 → 有效观测 → 跟随意图 → 控制输出，不调用 VLM 阻塞决策。
- [ ] follow 返回运动任务；失效、取消、目标丢失或设备故障时停止并提交明确终态/事件。
- [ ] 丢失后不默认旋转搜索或自动恢复运动；如需该行为，先按 R16 明确审批与安全条件。
- [ ] 用可控时钟和轨迹回放验证方向、限速、过期截止、遮挡、ID 变化和 stop 后不复活。
- [ ] 经 R16 放行才做受控真机跟随；记录距离依据、环境、人工停止手段与已知限制。

### R18 — 自动化回归与故障矩阵

- [ ] 覆盖全部公开操作、输入边界、响应/事件 schema、任务竞争、取消与停止。
- [ ] 对照 TS 基线验证兼容性；对于有意修正的旧缺陷，明确期望差异而不是要求错误行为一致。
- [ ] 覆盖 WS 游标窗口、重启、慢消费者、板复位、模型退出、相机无帧、音频故障与队列过载。
- [ ] 校验只经契约调用、debug 排除、内部时间戳不外泄、未知状态不造假。
- [ ] 类型检查、仿真与契约门禁可以无硬件运行；真机测试显式标记，不能在默认测试中触发运动。

### R19 — 时序与目标机实测

- [ ] 固定并记录软硬件版本、固件、配置、控制隔离机制、负载和测量起止点。
- [ ] 测 stop 端到端目标 ≤50 ms；明确测的是板侧停止处理而非未经传感器验证的物理静止。
- [ ] 测心跳失效至板侧看门狗停机目标 ≤500 ms；同时验证管理失活/意图过期不会无限喂狗。
- [ ] 在模型慢推理、相机负载、HTTP/WS 过载与串口故障下复测；报告样本数、分位数、最大值与超标次数。
- [ ] 检查 host velocity ≥5 Hz、普通板命令应答超时目标 500 ms；未达标保持阻塞，不放宽目标伪装通过。
- [ ] 结论和复现步骤写入 `eval/`，原始日志/视频进 `work/`；历史 TS 实测不能替代 Python 验收。

### R20 — 切换与交付

- [ ] 更新 robotd 包 README、项目入口与启动脚本，写明安装、配置、权限、仿真、真机及故障排查。
- [ ] 先提供显式 Python 启动入口；R19 通过后才切换默认，面板与 agentd 做端到端回归。
- [ ] 切换前停止旧串口持有者并确认释放，不做两套运行时同时驱动真机的灰度。
- [ ] 写明回退步骤与停止前置条件，保留旧 POC，不擅自删除历史实现或改现有协议版本。
- [ ] 补齐 agentd 网络客户端/审批适配的协作依赖；依赖未完成不能宣称整机迁移完成。
- [ ] 更新任务证据、已知限制与验收结果；不把未实现的 YOLO/SLAM/急停写成现成功能。

## 5. 阶段出口与执行顺序

| 里程碑 | 通过标准 | 明确不代表 |
| --- | --- | --- |
| M0 设计就绪 | R01–R03 完成，隔离方案与接口差异有明确结论 | 已完成迁移 |
| M1 仿真身体内核 | R04–R08 完成，状态/任务/控制与故障逻辑可重复验证 | 真机时序达标 |
| M2 网络契约闭环 | R09–R10 完成，HTTP/WS 仿真可用，未接能力明确失败 | 所有 v1 能力已交付 |
| M3 设备与慢路径 | R11–R14 完成，真实设备与模型/音频隔离成立 | 已有可靠人物跟随 |
| M4 受限跟随 | R15–R17 完成，安全边界明确并通过受控验证 | 全自主导航或无人看护安全 |
| M5 迁移放行 | R18–R20 完成，回归与时序有证据，显式切换可回退 | 硬件急停或 SLAM 已实现 |

**首个开发批次只做 R01–R03**：先厘清差异、确认控制隔离，再补契约。
随后交付 R04–R08 的最小仿真内核；不以先接 YOLO、先建导航框架或复制大 Runtime 为起点。

本计划不是架构决策替代品。HTTP 框架、Python 控制隔离、跟随距离依据及安全策略在对应任务中
给出候选、证据与结论；影响结构或行为的选择需确认后实施。项目内不写知识库分类日志。

## 6. 相关依据

- [robotd 对外接口契约 v1](robotd-interface-contract.md) —— 公开行为与验收缺口。
- [ADR-0006](../decisions/0006-robotd-event-driven-core.md) —— 单点状态与事件归并（proposed）。
- [ADR-0007](../decisions/0007-agentd-robotd-boundary.md) —— agentd/robotd 边界（accepted，运行时公开接口，无对端文件读取例外）。
- [ADR-0009](../decisions/0009-robotd-python-runtime.md) —— Python 方向与控制隔离待设计项。
- [分层通信与接口设计](../communication-protocol.md) —— 板侧通信、时序与故障边界。
- [语音改造方案](../voice-architecture.md) —— 流式音频与打断语义。
- [视觉延迟实测](../../eval/vision-latency.md) —— 现有快慢路径证据，非新实现性能保证。

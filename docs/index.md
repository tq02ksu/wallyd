# WALLY 文档索引

本页是 `docs/` 的唯一入口，也是「现在以哪份文档为准」的清单。新增文档必须登记到本页，
否则 CI 的文档检查会报「未登记」。

> **实现进度不在这里声明。** 能力的唯一事实源是代码、测试与
> [`project/architecture.md`](project/architecture.md#current-implementation-state) 的
> 「Current implementation state」；`robotd` 逐项能力以 `robotd/src/robotd/capabilities.py`
> 的注册表为准。文档描述目标与理由，不代表已实现。

## 状态标记

| 标记 | 含义 |
| --- | --- |
| 当前口径 | 与现有代码/契约一致，改动需走 ADR |
| 计划 / 草案 | 目标方案，尚未全部落地；不要当成现状 |
| 有时效 | 一次性核实或实测，结论绑定当时的时间点 |
| 归档 | 历史记录，不代表当前运行方式 |

## 1. 先看这些（当前口径）

- [项目总览（README）](../README.md) - WALLY 是什么、三进程边界、验证方式
- [项目架构](project/architecture.md) - 机器人运行时、不可协商的不变量、当前实现状态
- [Robot API](project/robot-api.md) - 契约是机器可读接口的唯一源；生成物不得手改
- [设备协议](project/device-protocol.md) - USB CDC JSON Lines、握手、看门狗与 stop 语义
- [硬件与电气基线](project/hardware-baseline.md) - 已采购基线及其工程验证风险

## 2. 详细设计（目标与约束）

> 这里描述目标设计与理由；是否已经实现，以 §1 的「当前实现状态」为准。

- [架构设计（C4）](architecture.md) - 四层视图、动态视图、模块与数据模型；继承自参考实现的完整设计
- [层与模块关系（唯一口径）](layers-and-modules.md) - 「层」这个词的唯一解释：执行位置、边界 B1–B4、接口面 A–C
- [分层通信与接口设计](communication-protocol.md) - 进程内/进程间/线协议每条边界的传输方式
- [语音输入输出改造方案（流式优先）](voice-architecture.md) - 语音从 request/response 改为流式管线；方案已部分落地
- [GH-4 语音桥双管道设计](design/GH-4.md) - 拾音（采集→VAD→ASR）与出话（分句→合成→有界队列→渲染）拆分及可替换 engine 边界
- [GH-5 播报期 VAD 门控](design/GH-5.md) - 桥只报事实、AudioRuntime 单点判 barge-in，产出 `speech.gate`
- [GH-6 实时 AEC3 / speech_abort](design/GH-6.md) - 停止播报端点、打断计数对账、AEC3 离线证据驱动的门限取值与实时接入方案
- [GH-7 语音 final 变成 run](design/GH-7.md) - `onUtteranceHeard` 走与 `POST /api/run` 同一路径；因果断言、审批/执行分层、中断 final 与 `speech.ignored` 窄事件
- [GH-9 常听会话状态机](design/GH-9.md) - AudioRuntime 的 idle/listening/thinking/speaking、runtime 驱动的自动续听、`inter_utterance_ms` 防抖与只拦非打断自动轮的 `speaking` 闸
- [GH-13 run 结论播报](design/GH-13.md) - run 终态经 `robot_speak` 播报；一次性凭据、run_id 幂等、barge-in 只标 `narration: interrupted` 不改 run 状态
- [GH-14 语音回归基线](design/GH-14.md) - 夹具 + 一条命令量出 §11 的 6 项门槛；离线/真机两档、逐项 measured/SKIP、绝对值与 20% 相对退步取严
- [GH-57 结构化停止原因](design/GH-57.md) - `safety.stop_requested.cause` 必填枚举、`unknown/device_lost` 与 `confirmed/watchdog_timeout` 语义、agentd `blocking_reason` 归属与播报
- [模型选型](model-selection.md) - LLM / TTS / ASR 选型（苹果生态优先，2026-09-17 口径）
- [产品定位与套件化约束](product-positioning.md) - 平台而非成品、套件化销售的口述决策
- [可行性评估与技术风险清单](risk-assessment.md) - R1–R7 风险项与验证顺序

## 3. 硬件与电气

- [硬件选型与采购方案](hardware-selection.md) - 候选器件、参考价与下单前核实要点
- [电气系统架构](electrical-architecture.md) - 分层、功率树、电源域与 I/O 规划
- [电源架构](power-architecture.md) - 12V 稳定电源 + 逆变器的取舍
- [步进驱动接线与供电](stepper-wiring.md) - ESP32-S3 + TB6600 的接线与两态制
- [接线端子与防呆规划](wiring-connectors.md) - 测试期与扩展期的端子规划

## 4. 实现规范与计划（计划 / 草案）

- [实现规范入口](spec/README.md) - 本目录的定位：不得覆盖总体架构的口径
- [robotd 对外接口契约 v1（设计稿）](spec/robotd-interface-contract.md) - HTTP/MCP、状态、WebSocket 事件、任务与安全时序
- [robotd Python 模块开发计划](spec/robotd-development-plan.md) - 六阶段任务、依赖与逐项完成标准
- [robotd TS→Python 迁移差异矩阵](spec/robotd-migration-matrix.md) - 逐项登记迁移现状、判定与承接任务
- [agentd 详细功能与界面设计](spec/agentd-functional-design.md) - 编排、模型配置、总览/任务/事件界面与安全边界
- [agentd 开发任务清单](spec/agentd-development-plan.md) - 六阶段任务与分批交付门槛
- [摄像头自动检测与配置](spec/camera-detection.md) - macOS UVC 判定与采集配置
- [GH-17 事件归并的「先算后发」设计](design/GH-17.md) - 归并工作副本、失败丢弃、`state.rejected` 与订阅 backlog 语义修正
- [GH-27 澄清不建 run 的设计](design/GH-27.md) - 澄清/歧义只写 `route.clarify` 事件、不占活动名额；受保护的停止规则不受忙限制
- [GH-49 澄清闭环的设计](design/GH-49.md) - 追问经 `robot_announce` 模板播报、事件带 `question`、30s 等待补充窗口把下一句接上
- [GH-8 快速路由规则表的长大方式](design/GH-8.md) - 否定按作用域判断、结构化参数槽、三条规则与能力漂移断言
- [GH-10 Harness 执行器](design/GH-10.md) - 一会话一 thread、显式 CODEX_HOME、原始事件只落 jsonl、取消走 abort

## 5. 契约专题（有时效）

- [接口契约升级方案](contract-upgrade.md) - 提案：把「生成 + 门禁」的做法补到板侧线协议与模型帧
- [时间约束与接口契约 — 现状核实](timing-contract-review.md) - 2026-10-18 的三态核实（已实现 / 已定稿未实现 / 真空白）

## 6. 架构决策（ADR）

- [决策日志与待回填清单](decisions/README.md) - 每条决策的动机、代价与验证方式

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [ADR-0001](decisions/0001-vision-fast-slow.md) | 视觉走快慢双路径 | accepted |
| [ADR-0002](decisions/0002-closed-loop-layering.md) | 闭环分两层：编码器在 ESP32、低频修正在 robotd | accepted |
| [ADR-0003](decisions/0003-timing-constraints-layering.md) | 时间约束分层已成立，只补两个跨层参数 | proposed |
| [ADR-0004](decisions/0004-serial-contract-redlines.md) | 串口契约 v2：不可知状态红线与取消语义 | proposed |
| [ADR-0005](decisions/0005-contract-upgrade-v2.md) | 契约升级到 v2：可发现的线协议与模型帧 | proposed |
| [ADR-0006](decisions/0006-robotd-event-driven-core.md) | robotd 以事件循环为内核、状态单点持有 | proposed |
| [ADR-0007](decisions/0007-agentd-robotd-boundary.md) | agentd / robotd 模块边界分离 | accepted |
| [ADR-0008](decisions/0008-robotd-control-worker.md) | robotd 用 Control Worker 隔离导航（Node 方案已取代） | superseded |
| [ADR-0009](decisions/0009-robotd-python-runtime.md) | robotd 新架构采用 Python | accepted |
| [ADR-0010](decisions/0010-robotd-python-control-isolation.md) | Python 控制隔离与串口所有权（候选 A） | proposed |
| [ADR-0011](decisions/0011-audio-bridge-app-bundle-tcc.md) | 音频桥做成 .app bundle 并由 open 拉起 | accepted |

## 7. 设计记录（按 issue）

- [GH-4 语音桥双管道设计](design/GH-4.md) - 拾音（采集→VAD→ASR）与出话（分句→合成→有界队列→渲染）拆分及可替换 engine 边界
- [GH-17 事件归并的「先算后发」设计](design/GH-17.md) - 归并工作副本、失败丢弃、`state.rejected` 与订阅 backlog 语义修正
- [GH-18 审批拒绝侧设计](design/GH-18.md) - `X-Wally-Approval` 一次性凭据、共享秘密与已消费 nonce 账本
- [GH-19：审批复述的系统播报路径](design/GH-19.md) - `robot_announce` 的契约、事件与确认窗口时序
- [GH-11 语音确认通道设计](design/GH-11.md) - `waiting_confirmation` 的语音 settle、窗口/回声规则与凭据签发
- [GH-48 任务暂停/恢复](design/GH-48.md) - `POST /v1/tasks/{id}/pause|resume`、`TaskState.paused`、暂停上限与安全优先级；resume 不重签审批
- [GH-36 macOS CI 门禁分档](design/macos-ci.md) - `apple` lane 的编译/纯逻辑测试/AEC3 fail-closed 口径，以及哪些真机判据永远留给人
- [GH-14 语音回归基线](design/GH-14.md) - 夹具 + 一条命令量出 §11 的 6 项门槛；离线/真机两档、逐项 measured/SKIP、绝对值与 20% 相对退步取严

## 8. 实测与评测（有时效）

- [视觉延迟实测（2026-10-06）](../eval/vision-latency.md) - VLM 0.84s/帧 vs 系统检测器 4–20ms
- [视觉评测脚本使用说明](../eval/README.md) - 上面那份实测怎么复跑
- [AEC 实验脚本（R14）](../eval/aec3/README.md) - 回声消除的量化方法与实验纪律
- [R14 语音链路实测（2026-10-24）](../eval/r14-voice-bringup-2026-10-24.md) - ASR/TTS 复跑证据、TCC 根因、AEC 与 barge-in 限制
- [本地大脑全链路验证（2026-10-25）](../eval/brain-qwen3-toolcalling-2026-10-25.md) - Codex→moon-bridge→mlx_lm→Qwen3-4B 端到端与工具调用通过率
- [Codex app-server 接入取证（A01）](../eval/codex-harness-probe.md) - SDK 分发、进程边界与 `CODEX_HOME` 隔离的实证

## 9. 历史归档（不代表现状）

- [历史文档归档说明](archive/README.md) - 归档范围与「以现行文档为准」的声明
- [POC 使用说明](archive/poc-readme.md) - 已删除的 POC 的启动与排错记录
- [POC 分层通信链路设计与验证](archive/poc-design.md) - POC 的设计决策与实测
- [接口契约重设计](archive/interface-redesign.md) - 早期提案；面板审批已被语音确认取代
- [docs/ 文档整理方案](archive/reorg-plan.md) - C4 重组前的一次性体检

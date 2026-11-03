---
title: 机器人 POC — 使用说明
type: project
description: POC 的运行手册：前置条件、一键启动（仿真 / 真机）、robotd 命令行开关、面板两个子页的用法、验收与台面脚本、固件上传与还原、常见故障排查与文件清单。
tags: [project, robot, poc, usage]
domain: robot
project: macmini-robot
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-06T01:10:00+08:00 }
---

# 机器人 POC — 使用说明

> **归档：本文记录旧版 POC 的运行方式，不代表当前运行手册。**

> 只讲**怎么跑**；为什么这么设计见 [poc-design.md](poc-design.md)。
> 除非特别说明，下面所有命令都在**项目根目录**（`<wallyd-root>/`）执行。
> ⚠️ 2026-10 起代码在 `<wallyd-root>/src/`（不再是 `poc/`），文档在本目录。

## 0. 前置条件

| 项 | 说明 |
| --- | --- |
| 运行机 | macOS（Apple Silicon 实测） |
| Node / npm | ≥ 22。**本机已装**：`~/.local/bin/node`（v24.21.0，自带 npm 11，`~/.local/bin` 已在 PATH）。没装时可用 Codex 运行时自带的 Node（`/Users/tq02ksu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，能直接跑 `.ts`，靠类型擦除，不做类型检查） |
| 依赖（必装） | `npm ci`（在项目根执行）。**不做这步 robotd 起不来**——它 import 了 `yaml` + `openapi-backend`（契约驱动），缺了直接 `ERR_MODULE_NOT_FOUND`。项目里的 `.npmrc` 已把源指到国内镜像 `registry.npmmirror.com`，装完约 68 个包 |
| Python | `/usr/bin/python3`（系统自带即可；POC **不用 pyserial**，串口走 `lib/pyshim`，仅标准库 termios） |
| 真机 | ESP32-S3（已烧协议 v2 固件）+ TB6600；串口名用 `ls /dev/cu.usb*` 查（实测 `/dev/cu.usbserial-A5069RR4`） |
| 真模型 | MiniCPM-V 4.6 4bit 权重 + MLX 环境（默认 `$BOT/models/MiniCPM-V-4.6-4bit`、`$BOT/.venv`，`BOT` 默认 `/Users/tq02ksu/workspace/bot`）。**权重必须已在本机**，`run.sh` 设 `HF_HUB_OFFLINE=1`，推理不联网 |
| Metal | 模型服务**必须在沙箱外/非受限进程里跑**，受限沙箱会报 `No Metal device available` |
| 相机授权 | **必须给承载 robotd 的 App 授权摄像头**（系统设置 → 隐私与安全性 → 摄像头 → 勾选该 App，本项目实测是 **ChatGPT**，因为 Codex 会话跑在它里面）。**未授权时 AVFoundation 不报错、只是永远不出帧**——表现是 `camera.capture` 等帧超时；`swift scripts/uvc_capture.swift list` 会打印 `camera_authorization`。改完授权要**重启该 App** |
| 相机带宽 | 这颗 HDI Webcam USB **只有未压缩格式**（`420v`/`yuvs`，没有 MJPEG）：1280×720@30 ≈332Mbps，贴着 USB2 上限 ⇒ 出帧时好时坏。所以 `camera.capture` **默认不钉格式**（让系统协商），要钉尺寸就同时限帧率（`--camera-fps`，默认 10）。**别用 `camera.capture({width:1280,height:720})` 那种写法去"省算力"**——只会更不稳 |
| 麦克风授权 | 同摄像头：**未授权时录音不报错、只是录到空音频**，转写必然为空（表现是"它听不到我说话"）。授权开关在 **系统设置 → 隐私与安全性 → 麦克风**，勾选承载 robotd 的 App（本项目实测是 **ChatGPT**），改完**重启该 App**。`audio.list` 会打印 `microphone_authorization` |

```bash
# 建议先设两个变量，后面命令都用它们
NODE=$(command -v node || echo /Users/tq02ksu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node)
ROBOT=.                       # 项目根（package.json / contracts / doc / scripts / src / eval 都在这下面）
```

## 1. 快速开始

### 1.1 一键起（真机 + 模型 + 面板 —— 日常就用这个）

```bash
sh src/run.sh                              # 默认串口 /dev/cu.usbserial-A5069RR4 + :8787
sh src/run.sh /dev/cu.usbserial-XXXX 8787  # 指定串口与端口

POC_MODEL=stub sh src/run.sh               # 退回 stub 模型（只验链路，不加载权重）
POC_MODEL_NAME=minicpm-v-4.6-4bit sh src/run.sh   # 自定义对外模型名
```

`run.sh` 会**同时拉起两样东西**并把接线接好：

> ⚠️ **停服务前先问**：`run.sh` 开头会 `pkill -f robotd.ts / mlx_vlm.server`。这套服务常常正被用户
> 开着面板使用（模型加载要几秒到几十秒），**Agent 不要为了"收尾"顺手把它停掉**——用户的机器上
> 服务默认应该一直开着，除非用户明确说要停。

1. **视觉模型**：`mlx_vlm.server`（:8080，默认 `MiniCPM-V-4.6-4bit`），日志 `/tmp/vlm-server.log`；
   `run.sh` 会轮询 `/health` 直到就绪（实测约 3s）再启动 robotd。
2. **robotd**（:8787，带 `--debug`）：放前台，串口日志直接可见；并按
   `--modeld http://127.0.0.1:8080 --model MiniCPM-V-4.6-4bit` 接上模型（**robotd 的默认值不是 8080**，见 §0.1）。

起来后打开面板 <http://127.0.0.1:8787/>（四个子页：ESP32 / robotd / 视觉 / 语音）。**Ctrl-C 停 robotd**；
模型是后台进程，要一起停用 `pkill -f mlx_vlm.server`。

`POC_MODEL=stub` 时改起 `modeld.py`(:8790) 的确定性 stub 后端——不加载权重、只验证跨进程链路
（但 stub **不能看图**，`vision.describe` 只会得到假回复）。

### 0.1 一定要知道的坑：robotd 的默认模型地址是 8790，不是 8080

`robotd` 自己起来的默认是 `--modeld http://127.0.0.1:8790 --model poc`（stub 端口）。
所以**如果你绕过 `run.sh` 直接起 robotd、又没给 `--modeld/--model`**，视觉链是断的——
而且它**不会在启动时报错**，只有等你真去调 `vision.describe` 才失败（面板「模型」子页会显示 health_error）。
语音不受影响（ASR/TTS 走 macOS 系统能力，不经过 modeld）。

判断"模型到底起没起 / 接没接对"，一条命令：

```bash
curl -s http://127.0.0.1:8787/v1/debug/model   # 看 modeld=、model=、health、models 三处是否一致
```

**注意**：模型与 robotd 是两个进程，`vision.describe` **不带图片时真模型会凭空描述画面**
（实测问"画面里有几个人"它答"一个坐长椅的女性、一个站着的男性"）。返回值里的 `grounded`
字段标明这次描述**有没有像素依据**；不带图时它是 `false`，别当观测用。

**模型名**：`mlx_vlm.server` 把 `/v1/models` 的 `id` 直接取成启动时 `--model` 的**原字符串**，
请求侧也按字符串精确匹配（`cache_key = (model_path, …)`）。所以 `run.sh` 用「以权重目录为 cwd +
只传目录名」的方式起服务，id 就是一个干净名字（默认 `MiniCPM-V-4.6-4bit`，即权重目录名），
而不是一串绝对路径；`POC_MODEL_NAME=<名>` 换名时会在权重目录旁自动建一个同名软链指回真实权重。
robotd 的 `--model` 必须与这个 id 一模一样，否则服务会把该名字当成新模型去解析（本 POC 已设
`HF_HUB_OFFLINE=1`，误配只会显式报错，不会偷偷联网下载）。

### 1.2 纯仿真（无硬件，验全部协议与契约）

```bash
$NODE --experimental-strip-types $ROBOT/src/robotd.ts --sim --http 8787 --debug &
$NODE --experimental-strip-types $ROBOT/src/tools/smoke.ts --url http://127.0.0.1:8787 --label sim
```

### 1.3 真机

```bash
$NODE --experimental-strip-types $ROBOT/src/robotd.ts --port /dev/cu.usbserial-A5069RR4 --http 8787 --debug &
$NODE --experimental-strip-types $ROBOT/src/tools/smoke.ts --url http://127.0.0.1:8787 --label hardware-debug
```

注意两点：**不带 `--debug`** 时，降级 / 链路巡检那几条会自动 SKIP；真机验收会**真的动**（含位移），
先确认车在台架或空旷处。

### 1.4 分成两个终端起（想单独看模型日志 / 只重启一个）

**终端 A — 视觉模型**：

```bash
BOT=${BOT:-/Users/tq02ksu/workspace/bot}
cd "$BOT/models" && exec "$BOT/.venv/bin/mlx_vlm.server" \
  --model MiniCPM-V-4.6-4bit --host 127.0.0.1 --port 8080
```

**终端 B — robotd（真机 + 接上模型）**：

```bash
cd <wallyd-root>
node --experimental-strip-types src/robotd.ts \
  --port /dev/cu.usbserial-A5069RR4 --http 8787 --debug \
  --modeld http://127.0.0.1:8080 --model MiniCPM-V-4.6-4bit
```

> 这两条就是 `run.sh` 干的事，只是拆开手动执行。**`--modeld`/`--model` 必须显式给**，
> 否则会退回默认的 `8790/poc`（stub 端口）→ 视觉断。

### 1.5 npm 脚本（`cd <wallyd-root>` 后直接用）

装了 Node 以后，这些比手敲 `node --experimental-strip-types …` 省事：

```bash
npm run contract:generate   # 改完 contracts/openapi.yaml 后重新生成 MCP 工具面 / TS 类型 / openapi.json
npm run contract:check      # 校验 generated/ 与 openapi.yaml 逐字节一致（CI 用；改契约没重生成会 FAIL）
npm run robotd              # 真机 robotd（串口/端口写死在脚本里）
npm run robotd:sim          # 仿真 robotd
npm run smoke               # 契约验收（对着 :8787）
npm run speech:vad          # 语音端点逻辑离线自测
npm run speech:build        # 把语音桥编译成二进制（配合 --speech-bin）
```

> 改契约的固定动作：改 `contracts/openapi.yaml` → `npm run contract:generate` → `npm run contract:check`。
> **不要手改 `contracts/generated/**`**（check 是逐字节比对，手改会在下次校验时 FAIL）。

## 2. robotd 命令行开关

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| `--sim` | 关 | 仿真板（不开串口），无硬件时用 |
| `--port` | `/dev/cu.usbserial-A5069RR4` | 串口设备 |
| `--baud` | `115200` | 波特率 |
| `--http` | `8787` | HTTP + WebSocket + 面板端口 |
| `--modeld` | `http://127.0.0.1:8790` | 模型服务地址 |
| `--model` | `poc` | modeld 的模型 id。真模型下**必须与 `/v1/models` 完全一致**（默认 `MiniCPM-V-4.6-4bit`，`run.sh` 会自动传对；见上文「模型名」） |
| `--model-max-tokens` | `96` | 单次生成上限（真模型实测 ≈20 tok/s，96 token ≈5s，留在 10s 超时内） |
| `--camera-bin` | `/usr/bin/swift` | 抓帧原生桥的入口；也可指向编译好的二进制（`swiftc -O -o /tmp/uvc_capture scripts/uvc_capture.swift`，省掉每次编译的 1–2s） |
| `--camera-device` | 空（第一个视频设备） | 设备名子串 |
| `--camera-rotate` | `0` | `0` / `180`：装机倒装时摆正画面。⚠ 同时会把左右翻转，视觉伺服算转向时要和取帧用同一朝向 |
| `--camera-attempts` | `3` | 抓帧重试次数（实测这台 UVC **会间歇性第一次不出帧**；抓帧是只读操作，重试无副作用） |
| `--camera-fps` | `10` | 钉格式时的帧率上限。**限帧率＝限 USB 带宽**：这颗摄像头只有未压缩格式，1280×720@30 ≈332Mbps、贴着 USB2 上限 |
| `--nav-turn-sign` | `1` | **目标偏右时往哪边转**：`1` = 顺时针（`deg>0`）。相机装反/取帧朝向不对就设 `-1` |
| `--nav-deadzone` | `0.12` | 框中心偏离画面中心小于这个比例就不转（0–1），避免小幅摇摆 |
| `--speech-bin` | `/usr/bin/swift` | 语音原生桥（ASR/TTS）的入口；也可指向编译好的二进制——先 `npm run speech:build` 再传 `work/bin/mac_speech`。runtime 自动区分「解释器 + .swift 路径」与「二进制本身」两种形态 |
| `--speech-aec` / `--no-speech-aec` | 开 | 输入侧语音处理（AEC 回声消除）。**默认开**：真机实测不开时机器人会听见自己说话并打断自己；`--no-speech-aec` 关 |
| `--speech-locale` | `zh_CN` | ASR locale（`zh_CN` 资产已装；见 `audio.list`） |
| `--speech-voice` | 空 | 默认 TTS 音色；空 = 桥自己挑 `zh-CN` 音色 |
| `--debug` | 关 | 打开调试旁路 `POST /v1/debug/serial`（P5：不进 MCP 工具面） |
| `--no-heartbeat` | 关 | 故意不喂心跳，验板侧看门狗会自主停机 |
| `--no-approval` | 关 | 关掉审批门（自动化测试用） |
| `--json-log` | 关 | 结构化日志 |

## 3. 面板怎么用

顶栏常显：robotd 连接状态、transport、固件版本、**ESP32 链路（ready / lost）**、STOP
（免审批、任何情况下可抢占）。

| 子页 | 管什么 | 需要 |
| --- | --- | --- |
| **ESP32** | 板侧协议与台面接线：`hello` 握手、`status`（可开 1s 轮询）、**ENA 使能↔脱机**、台面探针 `pins` / `pulse` / `led`、**串口原始行日志**（`→` 发出 / `←` 回话，心跳打折） | `--debug` |
| **robotd** | Runtime 接口：`/healthz`、State、任务列表、能力表单（量程 + 单位都来自能力面）、**手动驾驶**、事件流 | — |
| **视觉** | **`camera.capture` 抓帧**（带预览图，抓完自动把路径填进下面两个表单）、模型服务状态（modeld 地址 / `/v1/models` / `/health`，并比对 robotd `--model` 是否一致）、**`vision.describe` 能力表单**（图片路径或 data URL，结果带 `grounded`）、**调试旁路**原样发一发 OpenAI 请求（预设：描述 / grounding 定位 / 数个数；可调 `max_tokens`、`temperature`） | 抓帧走能力面；状态、预览与旁路需 `--debug` |
| **语音** | ① 音频现状（麦克风设备 + **授权状态**、中文音色、ASR locale 与资产状态）。② **流式听**：实时显示 **VAD 状态 / 电平 dB / 端点（静音/语音时长）/ 延迟（首字、端点→终稿）/ 第几次修订 / 实时文本**，「静音自动收尾」可勾选；也可点「停止听/说」提前收尾。③ 一次性听（录满 N 秒再转写，适合一句指令）。④ **流式说**：走 `/v1/robot/speak`（和 Agent 同一条路），整段分句后**一块一块播**，面板显示「正在播第 i 块 / 播完 N 块」，播放中说话会打断 | 流式那两条需 robotd 带 `--debug`（走调试旁路 `POST /v1/debug/call` 与 WS）；「说」那条走公共 `/v1/robot/speak` |

> **流式的两个实测坑（2026-10-10）**：① 中间结果**曾经根本不实时**——Swift 脚本顶层代码是
> `@MainActor` 隔离的，普通 `Task{}` 继承 main actor、被主流程的阻塞等待饿死，结果全攒到结束才吐；
> 改成 `Task.detached` + 异步等待后才真实时（partial 在 1.2s/2.8s/3.6s 出现）。
> ② **静音自动断句目前不可用**：系统 `SpeechDetector` 与 `SpeechTranscriber` 放同一条 analyzer 时
> 两边都收不到结果（对照实验：不带 detector 24 条 partial、带 detector 0 条），所以 `audio.stream`
> 的 `auto_endpoint` **默认关**——现在仍是"点停止 / 到上限"。详见 [[poc-design]] 的 2026-10-10 记录。

- **手动驾驶**：↑↓←→ 按住走、松开停，空格急停；速度 0.05–0.4 m/s、步长 0.05–0.3 m、转角 5–45°。
  实现是"按住 → 循环发小步任务，松开 → `motion.stop`"，走的是**同一套能力接口**，没有新开旁路；
  另有两道保险：焦点在输入框时不抢方向键、**2s 死手兜底**（丢 keyup 也不会一直走）。
- **ENA 使能 / 脱机**：用于接线核对、量脱机前后的静置电流。属 P5 调试旁路，Agent 看不到、也调不到。
- **模型页两条路分得很清楚**：上半按**能力面**调 `vision.describe`（和 Agent 走同一条路，`grounded` 标明这条描述有没有像素依据）；
  下半是**调试旁路** `POST /v1/debug/model`，直接把请求原样打给模型服务——调提示词与 grounding 格式用这条，
  它不映射成 MCP tool、Agent 看不到（P5）。刚跑出来的 grounding 结论也在页面上：
  原生格式 `<box>x1 y1 x2 y2</box>`、坐标 **0–1000 归一化**、**目标不存在时照样会给框**，所以框必须复核。
- **`vision.find(target, image)`（找目标）**：先让模型给框，再把框**裁出来换个问题复检**——问题从"它在哪"
  换成"这块区域里是不是它"，后者**允许回答"没有"**。返回 `{found, box, crop, verify_text, reason}`；
  框是 0–1000 归一化，裁图用系统自带 `sips`（不引新依赖），单次 ≈1.4–2.2s。
  ⚠ **同一个模型自检有共同盲区**：实测对图里不存在的「杯子」，模型给了假框、复检也点头（裁出来是地板），
  于是 `found=true` 但是错的。所以 **`found` 现在还不能当"确实存在"用**——要更高可信度得加独立信号
  （换模型/换任务，如系统 Vision 分类或 CLIP 零样本），或用带标注的数据先量化命中率与误报率。
- **`nav.approach(target, …)`（走过去）**：**任务级闭环**——抓帧 → 找目标 → 框偏就转、框小就前进、
  框够大就停；连续两轮看不到 / 超时 / 超步数 / STOP **立刻停**。它**不看语义真假**，只跟几何
  （感知给什么框就跟什么框）——这正是「Agent 决定做什么、控制系统决定怎么做」的分工：Agent 给目标，
  怎么转怎么走什么时候停由这一层算。参数：`stop_width_ratio`（框宽占画面多少算"到了"，默认 0.35）、
  `step_m`、`turn_deg`、`max_rounds`、`max_seconds`。
  实测（未接轮子）：3 轮 `forward 0.05m`、任务 `completed`、15.5s。

## 4. 验收与台面脚本

| 脚本 | 干什么 | 用法 |
| --- | --- | --- |
| `tools/smoke.ts` | 契约级验收 **35 条**：能力 / schema / 审批 / Task / 抢占 / 事件 / 单位 / 降级 / 复位 | `$NODE $POC/tools/smoke.ts [--url http://127.0.0.1:8787] [--label sim\|hardware]` |
| `npm run speech:vad` | 语音**端点逻辑离线自测**（能量 VAD 状态机：说→静音触发、短促噪声不触发、纯静音不触发） | `cd <wallyd-root> && npm run speech:vad` |
| `npm run speech:build` | 把语音桥编译成二进制（`work/bin/mac_speech`），配合 `--speech-bin` 用，省掉每次调用重新编译的 1–2s 与满屏 warning | 同上 |
| `npm run camera:build` | 同理，编译相机桥（`work/bin/uvc_capture`） | 同上 |
| `npm run contract:generate` | 从 `contracts/openapi.yaml` 重新生成 `generated/{openapi.json,mcp-tools.json,robotd-types.ts}` | 同上 |
| `npm run contract:check` | 校验生成物与契约逐字节一致（改契约忘了重生成会 FAIL） | 同上 |
| `npm run speech:fixture` | 生成测试音频（静音 + 合成语音 + 静音）到 `work/eval/speech/` | 同上（先跑它再跑下面那条） |
| `npm run speech:test` | **语音流式回归 17 项**：说（分句流式 TTS）5 + 听（流式 ASR + 自动端点）8 + 打断（barge-in）4；用 dry-run 与音频文件两个接缝，**不需要声卡** | 同上 |
| `tools/watchdog_test.ts` | 故意不喂心跳 → 板子应在 300ms 内自主停机 | 先起 `robotd --no-heartbeat --http 8789`，再 `$NODE $POC/tools/watchdog_test.ts --url http://127.0.0.1:8789` |
| `tools/ena_test.ts` | 按节拍切「使能 ↔ 脱机」并打时间戳，供对照万用表 / 摸电机轴 | `$NODE $POC/tools/ena_test.ts --cycles 3 --hold 4` |
| `tools/drive_probe.ts` | 「ENA 极性 × 脉冲极性」四种组合各跑 200 步，人眼记第几次转 | `$NODE $POC/tools/drive_probe.ts --count 200` |
| `tools/pin_probe.ts` | 把 STEP / DIR / ENA 钉在已知电平，配万用表查断在哪一段 | `$NODE $POC/tools/pin_probe.ts` |
| `tools/agentd_smoke.ts` | agentd（可选，见 §7）的接口契约 | `$NODE $POC/tools/agentd_smoke.ts [--run]` |
| `tools/cam_list.swift` | 列出 AVFoundation 认到的相机（判摄像头可用性） | `swift $POC/tools/cam_list.swift` |

> `smoke` 的降级条目、`ena_test`、`drive_probe`、`pin_probe` 都走调试旁路，**robotd 必须带 `--debug` 启动**。

## 5. 固件：上传、备份与还原

```bash
# 上传：把 firmware/robot_server_v2.py 写成板子的 main.py（base64 分块 + 启动自检）
/usr/bin/python3 firmware/upload_v2.py

# 备份：读回板子的 main.py（默认落到 work/poc/firmware/board_main_backup.py，未入库）
python3 src/tools/board_dump.py [串口] [输出路径]

# 在板子上跑一段 MicroPython
python3 src/tools/board_exec.py --code "print('hi')"
```

> **每次上传 / 开串口都会复位板子**（DTR/RTS 复位电路）——这是设计内的行为，见 [poc-design.md](poc-design.md) §3 决策 2
> 与 §5 评审第 10 项。复位本身安全（GPIO 回高阻：不会乱走、`ENA` 悬空 = 保持锁轴），代价是**丢板侧状态**。

## 6. 排错

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `E_FW: proto mismatch（host=None）` | 发了裸 `{"op":"hello"}` | 带 `proto:2`（面板已改成从 `/healthz` 读协议版本再发） |
| 上传成功但板子没反应 | MicroPython 里 `global` 声明必须在函数内**任何使用之前**，否则 `main.py` 编译失败、静默掉回 REPL | 上传脚本已加启动自检；确认串口日志出现 `ready` |
| 电机不转，但万用表"电平都对" | TB6600 共阳光耦：信号拉到 3.3V 时光耦两端仍约 1.7V、**部分导通** ⇒ 输入一直停在"有效"态，等不到边沿 | **两态制**：有效 = `Pin.OUT, value=0`（拉低），无效 = `Pin.IN`（高阻），**永不打高**。见 [stepper-wiring](../stepper-wiring.md) §2.3 |
| `quad_psram: PSRAM chip is not connected, or wrong PSRAM line mode` | 板是 N16R8（Octal PSRAM），镜像按 quad 初始化 | 不影响协议与电机（只用内部 SRAM）；做相机 / VLM 缓冲前换 Octal 构建 |
| 任务永远停在 running，之后 `motion.move` 全被 `E_BUSY` 顶回 | 旧版本没处理板侧 `boot` 事件 | 已修（[poc-design.md](poc-design.md) §5 第 10 项）：作废任务 + `pose.valid=false` + 重新握手 |
| `mode` 卡在 `degraded` 而 `esp32` 已是 `ready` | 链路巡检早于握手启动，把复位窗口的超时误判成失联 | 已修（巡检等握手 + 握手后显式置 `idle`）；验收脚本有断言钉住 |
| **开着 AEC 时，"用喇叭放音给麦克风听"测不出任何字** | AEC 的职责就是**消掉本机扬声器**的声音——它把你要测的信号也消了（真机实测：关 AEC 时同一段音频能识别出 `rms≈-7.3dB` 并触发端点；开 AEC 时完全收不到） | 这是预期行为，不是故障。测麦克风请用：真人说话 / `--speech-file` 走文件回放 / 临时加 `--no-speech-aec` |
| 标定 `PUT /v1/robot/odometry/calibration` 返回 `E_CMD: unknown op calib` | 板子上的固件还是旧的（`fw=poc-2.0`，caps 里没有 `calib`）；仓库里的 `firmware/robot_server_v2.py` 已更新（sim 报 `sim-2.1` 且带 `calib`） | 重刷固件即可（`firmware/upload_v2.py`，**会复位板子**）；重刷前标定在真机上不可用，但接口会**显式报错**而不是假成功 |
| 端口被占 / 行为像有残留进程 | 上一次没退干净 | `pkill -f robotd.ts; pkill -f modeld.py; pkill -f serial-bridge.py` |

## 7. 文件清单

| 文件 | 说明 |
| --- | --- |
| `robotd.ts` | Runtime（身体）：能力注册表、schema 校验、Task/Event、HTTP + WebSocket、面板托管 |
| `contracts/openapi.yaml` | 对外公共契约：`/v1/*` 控制面 + `/v1/events` WebSocket 订阅；`debug` tag 标出 `/v1/debug/*` 旁路 |
| `lib/schema.ts` | JSON Schema 子集校验器（产品里换 Zod） |
| `lib/miniws.ts` | 极简 WebSocket 服务端（推送 + close/ping） |
| `lib/pyshim/serial.py` | 串口 shim（仅标准库 termios，替代 pyserial） |
| `robot-mcp.ts` | 把能力映射成 MCP tool（stdio JSON-RPC） |
| `agentd.ts` | 可选：常驻 `codex exec` + 审批门；`--once "<任务>"` 是一次性用法 |
| `panel.html` | 调试面板（四个子页：ESP32 / robotd / 视觉 / 语音） |
| `../scripts/uvc_capture.swift` | **相机原生桥**（UVC 抓帧）：stdout 一行 JSON，`list` 看设备/格式/授权状态，`request-permission` 触发授权。robotd 的 `camera.capture` 就是 spawn 它 |
| `../scripts/mac_speech.swift` | **语音原生桥**（ASR/TTS，全走系统能力、不引模型）：`list`、`transcribe`、**`stream`（流式听：`ready`/`speech_state`/`partial(revision)`/`endpoint`/`final`，带 `ts_mono_ns`；**自带能量 VAD，默认说完自动收尾**，`--no-auto-endpoint` 可关，`--file <caf>` 可离线复现）**、**`speak-stream`（流式说：stdin 收句子块，边收边播，`stop` 立即取消；`--dry-run` 不碰声卡）**、`speak`、`vad-selftest`、`request-permission` |
| `../scripts/speech_fixture.swift` | **测试夹具生成**：用 `AVSpeechSynthesizer.write` 合成「静音 + 语音 + 静音」的 16k CAF，供 `stream --file` 测端点 |
| `tools/speech_test.ts` | **语音流式回归**（见 §4）：直接驱动 Runtime（绕开 HTTP，免 openapi-backend 依赖），断言说/听/打断三类事件与任务终态 |
| `modeld.py` | **stub** 模型服务（OpenAI 兼容、确定性回包，只验链路）。真模型不经过它——直接跑 MLX 的 `mlx_vlm.server`（见 `run.sh`）；`modeld.py` 里的 `--backend mlx` 是早期占位实现，**不可用** |
| `serial-bridge.py` | 原生串口桥（Node 清不掉 DTR/RTS，串口归它持有） |
| `run.sh` | 一键起模型服务（默认真模型 MiniCPM-V，`POC_MODEL=stub` 回退）+ robotd |
| `firmware/robot_server_v2.py` | 板侧固件：协议 v2、非阻塞状态机、心跳看门狗、两态制 |
| `firmware/upload_v2.py` | 固件上传（写成板子的 `main.py`） |
| `tools/` | 验收脚本与台面探针（见 §4） |

## 8. 未入库的产物（工作区 `work/`）

> 工作区是**项目内**的 `work/`（gitignored）。以下这批是 POC 期间产生的，当时写在**仓库根 `work/`**，
> **未迁移**、仍留在原处；新产物写项目内 `work/`。

- 仓库根 `work/poc/artifacts/panel-esp32.png`、`panel-robotd.png`、`poc-panel.png`：面板真机截图。
- 仓库根 `work/poc/artifacts/agentd-*.jsonl`：agentd 每次运行的原始事件流。
- 仓库根 `work/poc/firmware/board_main_backup.py`：上传 POC 固件前备份的原厂 `main.py`（还原用）。
- 仓库根 `work/refs/`（第三方源码）、`work/scripts/`（探针脚本）：复现资料。

## 相关页面

- [poc-design.md](poc-design.md) — POC 设计说明（决策、契约、评审结果）
- [[communication-protocol|分层通信与接口设计]]
- [[architecture|架构设计（C4）]]

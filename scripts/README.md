---
title: 机器人控制脚本集（ESP32 + USB 高层指令）
type: project
description: Mac mini 机器人项目中控制 ESP32-S3 的脚本集：板侧 MicroPython 指令服务器 + 电脑端 Python 控制 CLI，含灯模拟版与 TB6600 步进电机（M1）版，附 Python 环境配置说明。
tags: [project, robot]
domain: robot
generated: { by: agent:tq02ksu, at: 2026-09-20T00:00:00+08:00 }
---

# 机器人控制脚本集

本目录收录控制 ESP32-S3（MicroPython 指令服务器）的脚本，实现「电脑端脚本 → USB 串口 →
板子执行 → 返回响应」的完整控制链路。对应 [[architecture|架构设计]] §5.3 的「Codex 发高层指令、
ESP32 做实时运动控制」业务分层。

> **两个版本并存**：
> - **灯模拟版**（2026-09-20）：用板载 RGB 灯（WS2812，GPIO48）模拟动作，先打通 USB 控制链路；
> - **TB6600 步进版 / M1**（2026-09-2x）：`move`/`rotate` 改为经 `machine.bitstream` 在
>   STEP 引脚输出真实脉冲，驱动 TB6600 → 42BYGH47。
>
> 灯模拟版脚本（`robot_server.py` 等）保留作回归测试；上车走步进的用 `robot_server_steps.py`。

## 文件清单

### 灯模拟版（链路验证，2026-09-20）

| 文件 | 端 | 作用 |
| --- | --- | --- |
| `robot_server.py` | 板子 | MicroPython 指令服务器，监听串口、解析并执行指令（上传为板子 `main.py`） |
| `robot_cli.py` | 电脑 | 控制 CLI，连串口、发指令、收响应；支持单条指令与交互模式 |
| `upload_server.py` | 电脑 | 把 `robot_server.py` 上传到板子 `main.py`（raw-paste 方式） |
| `reset_and_test.py` | 电脑 | 复位板子并自动跑一轮指令测试，验证闭环 |
| `set_steady.py` | 电脑 | 把板子 `main.py` 改为「常亮单色」并立即生效（不闪烁） |

### TB6600 步进版 / M1（真实脉冲驱动，2026-09-2x）

| 文件 | 端 | 作用 |
| --- | --- | --- |
| `robot_server_steps.py` | 板子 | **M1 主固件**：TB6600 步进版指令服务器。`move`/`rotate` 用 `machine.bitstream` 发脉冲；引脚 左 STEP=GPIO4/DIR=GPIO5、右 STEP=GPIO6/DIR=GPIO7；细分 1/8（1600 步/圈） |
| `upload_steps.py` | 电脑 | 把 `robot_server_steps.py` 上传为板子 `main.py`（raw-paste，断行转义写入），并回读长度校验 |
| `interrupt_repl.py` | 电脑 | 发 Ctrl+C 中断板子在跑的 `main.py` 循环、验证是否回到 REPL（调试前置动作） |
| `test_bitstream.py` | 电脑 | 探针①：用 Python list of 0/1 试 `bitstream(p, 0, (2000,2000), bits)` 是否被接受 |
| `test_bitstream2.py` | 电脑 | 探针②：改用 `bytes([0b10101010]) * n` 传 data（list 形式失败后的修正） |
| `test_bitstream3.py` | 电脑 | 探针③：传**四元组 timing** `(2000,2000,2000,2000)`，确认最终可用写法 |
| `test_timer.py` | 电脑 | 探针：探测 `machine.Timer` 是否可用、init 签名 |
| `test_timer_step.py` | 电脑 | 备选方案：用 `Timer` 周期回调翻转 STEP 引脚（≈333 Hz），与 bitstream 路线对比 |

> **脉冲生成结论**：MicroPython 标准固件**无 RMT**；`bitstream` 需传**四元组 timing**
> `(high_ns, low_ns, high_ns, low_ns)`、data 用 `0xAA` 交替位（每 bit 一个 high-low 周期 =
> 一步）。详见 [[stepper-wiring|步进驱动接线与供电]] §5.5。

## 运行时原生桥（POC 运行时依赖，不是 ESP32 CLI）

| 文件 | 端 | 作用 |
| --- | --- | --- |
| `uvc_capture.swift` | 电脑 | **相机原生桥**（UVC 抓帧）。三个模式：`list`（列设备 / 格式 / 授权状态）、`capture`（抓一帧）、`request-permission`（触发授权弹窗）。stdout **恰好一行 JSON**（`{"ok":true,"data":{...}}`，契约见 [[communication-protocol]] §4），诊断一律走 stderr。robotd 的 `camera.capture` 能力就是 spawn 它，帧落 `work/poc/frames/` |

```bash
swift <wallyd-root>/scripts/uvc_capture.swift list
swift <wallyd-root>/scripts/uvc_capture.swift capture --out /tmp/a.jpg --width 1280 --height 720
```

> **摄像头授权是头号坑**：未授权时 AVFoundation **不报错、只是永远不出帧**（`session.isRunning`
> 仍是 true）——表现是等帧超时。`list` 会打印 `camera_authorization`；授权开关在
> 「系统设置 → 隐私与安全性 → 摄像头」，要勾选**承载该进程的 App**（本项目实测是 **ChatGPT**，
> 因为 Codex 会话跑在它里面），改完需重启该 App。macOS 不会为无 UI 的后台进程弹窗。

## Python 环境配置

脚本用 **Python 3 + pyserial**。macOS 自带 `python3`（或本机已装的 `python` 即 Python 3），
但**需要额外安装 pyserial**，`robot_cli.py` 第 9 行 `import serial` 依赖它。

### 方式一：系统 Python + pyserial（最简单，推荐）

```bash
# 1. 装 pyserial（一次性）
python -m pip install pyserial

# 2. 直接运行
cd /Users/tq02ksu/workspace/tq02ksu/persona/scripts
python robot_cli.py "status"
```

> 若报 `ModuleNotFoundError: No module named 'serial'`，说明没装 pyserial，执行上面的
> `pip install pyserial` 即可。不要用 `python2` / 系统旧版，脚本用 Python 3 语法与 f-string。

### 方式二：专用 venv（隔离、不污染系统）

项目已准备了一个 ESP32 专用 venv（内含 pyserial）：

```bash
# venv 路径
$HOME/.workbuddy/binaries/python/envs/esp32/bin/python

# 运行
$HOME/.workbuddy/binaries/python/envs/esp32/bin/python robot_cli.py "status"
```

### pyserial 校验

```bash
python -c "import serial; print('pyserial', serial.__version__)"
# 预期输出：pyserial 3.5
```

## 控制指令

| 指令 | 作用 | 灯模拟版响应 | 步进版（M1）响应 |
| --- | --- | --- | --- |
| `hello` | 测试连通 | `OK: hello from ESP32` | 同 |
| `led <r> <g> <b>` | 设灯色（指示/测试） | `OK: led set (255,0,0)` | 同（保留作状态指示） |
| `ledoff` | 关灯 | `OK: led off` | 同 |
| `move <步数> [back]` | 前进 / 后退 | 绿灯模拟 | **真实发脉冲**驱动两轮 |
| `rotate <角度>` | 转向（差速） | 橙灯模拟 | **真实发脉冲**（左右反向） |
| `stop` | 停止 | 红灯 | 红灯（当前不发脉冲，见下） |
| `status` | 查询状态 | `OK: status idle` | `OK: status idle microsteps=8` |

## 使用示例

```bash
# 单条指令（最常用，Codex 也方便调用）
python robot_cli.py "led 255 0 0"    # 灯变红
python robot_cli.py "move 1000"      # 灯模拟版：前进（绿灯）；步进版：真实走 1000 步
python robot_cli.py "status"         # 查状态

# 交互模式（连续敲命令，quit 退出）
python robot_cli.py

# 把 M1 步进固件烧成板子的 main.py（先 Ctrl+C 回 REPL）
python interrupt_repl.py            # 中断板子在跑的程序
python upload_steps.py              # 上传 robot_server_steps.py → main.py 并校验长度
```

## 注意事项

- **板子需插着**，串口设备 `/dev/cu.usbserial-A5069RR4` 需可识别，否则报「无法连接」。
- **板子需跑指令服务器**（`main.py` 已烧录，通电自动运行）。若板子被刷回 REPL，灯模拟版用
  `upload_server.py`、步进版用 `upload_steps.py` 重新上传。
- **灯模拟版 `move`/`rotate` 用灯色模拟**；要真实驱动步进请烧 `robot_server_steps.py`。
- **步进版参数**（`robot_server_steps.py` 顶部）：`MICROSTEPS=8`、`PULSE_NS=5000`（100 kHz，
  远超 TB6600 要求的 >1.2 µs）、`WHEEL_DIAM_MM`/`WHEEL_BASE_MM` 装车后按实测填（填 0 时
  `move` 直接用步数、`rotate` 用 1°≈4.4 步的退化近似）。
- **已知待完善**：① `stop` 只点红灯、**未真正中断正在发的脉冲**（bitstream 是阻塞调用，
  需分段发或加中断才能即时停）；② 加减速曲线尚未做，先低速跑避免丢步；③ 左右电机脉冲
  目前是**顺序发**（非真正同步），后续可优化为交替发。

## 相关页面

- [[architecture|架构设计]] §5.3 控制架构与控制权划分
- [[stepper-wiring|步进驱动接线与供电]] §5.5 ESP32 引脚分配与脉冲生成
- [[esp32-s3-setup|ESP32-S3 开发环境搭建与入手]]

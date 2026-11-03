---
title: 摄像头自动检测与配置（macOS / UVC 判定）
type: project
description: macOS 下摄像头可用性的四层判定流程（USB 枚举 → 系统相机列表 → 接口类描述符 → 实际出帧）、UVC 与非 UVC 的区分方法、采集与 VLM 链路配置要点，附实测画像（2026-10-09 起接入的是真 UVC：HDI Webcam USB，四层全通过；此前两颗 ZC0301 为非 UVC）。
tags: [project, robot, camera, uvc, setup]
aliases: [摄像头检测, 摄像头自动检测, UVC 判定, 摄像头配置]
domain: robot
project: macmini-robot
generated: { by: process:copilot, at: 2026-10-20T18:06:59+08:00 }
status: draft
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/hardware-selection.md
  - predicate: depends-on
    target: /docs/architecture.md
---

# 摄像头自动检测与配置（macOS / UVC 判定）

> 来源：2026-09-26 ~ 09-27 与用户的实测排查（MacBookPro11,2 / macOS 11.7.11，
> 被测试的两颗摄像头均为 Vimicro/Z-Star 老款非 UVC 设备）。所有命令均在本机跑过，
> 命令输出的原文见 §5 与 §3；与系统版本相关的推断见 §10 待核实。

## 0. 结论先行

- macOS 的视频输入只有**两条通路**：UVC（USB Video Class）硬件驱动，以及
  CoreMediaIO DAL 插件提供的虚拟相机（手机投屏类 App、OBS、NDI 等）。两者都不占的
  摄像头，在 macOS 上**无法使用**——这不是配置问题，也没有"装个驱动"的常规解法。
- **USB 层被识别 ≠ 能用**。私有协议摄像头会稳定停在"USB 枚举成功"这一层，
  表现和"插了但没反应"完全一样。
- 只有**设备级类为 0xFF（厂商自定义）且接口全为 0xFF** 时才可以判定为私有协议；
  反过来，设备类 0xFF 不等于非 UVC（UVC 判定要看**接口类是否为 0x0E**），所以必须读描述符，
  不能只看 `system_profiler` 的 USB 段。

> **状态更新（2026-10-09）**：用户已换上真 UVC 摄像头（`HDI Webcam USB`），四层判定
> **L1–L4 全部通过**，见 §0.4。下面 §0.1–§0.3 保留为那两颗 ZC0301 非 UVC 设备的排查记录
> （结论对那两颗仍然成立，只是不再代表当前接入的硬件）。

### 0.1 2026-10-03 复核：当前接入的摄像头仍是非 UVC（不可用）

在机器人目标主机（Mac mini / Apple Silicon / **macOS 27.0.1**）上复核，结论与 §5 完全一致：

| 项 | 实测 |
| --- | --- |
| 设备 | `PC Camera`，Manufacturer `Z-Star Corp.`，Location ID `0x02122000` |
| VID:PID | `0x0ac8:0x301b` |
| 系统侧（L2） | `system_profiler SPCameraDataType` **为空**（系统没把它当相机） |
| 描述符（L3，决定性） | 设备类 `0xFF`；1 个接口 × **8 档 alternate setting**，接口全部 `class=0xFF sub=0xFF proto=0xFF`；**无 `0x0E` 接口** |
| 端点 | `0x81` 等时 IN（各档最大包 0/128/192/256/384/512/768/**1023**）、`0x82` 中断 IN 8 字节 |
| **判定** | **非 UVC（厂商私有协议）→ macOS 无法使用** |

> **行动项**：这颗摄像头**不能**用于本项目的视觉链路（不是配置问题，也非权限问题）。要落地相机能力，
> 必须换一颗真 UVC 摄像头，到货后按 §3（四层判定）+ §4（读描述符）验货。

复现工具：描述符探针重建于 `work/scripts/usb_desc_probe.m`（`work/` 为临时产物，不入库），用法见文件头。

> ⚠️ **macOS 数据类型名**：本机（macOS 27）USB 列表用 **`SPUSBHostDataType`**；`system_profiler SPUSBDataType`
> 会返回**空**（无该数据类型，退出码仍为 0），容易误判成「USB 上什么都没有」。下文的命令按旧版写法给出，
> 在 macOS 27 上请改用 `SPUSBHostDataType`。

### 0.2 2026-10-05 复核：两颗摄像头是**同款 ZC0301**（查到确切型号与上游驱动）

用户换了一颗摄像头后重测（`work/scripts/usb_desc_probe`），**描述符与上一颗逐字节相同**
（`vid=0x0ac8 pid=0x301b`、8 档 alt、`class=0xFF`）→ **两颗同款**，换过去等于没换。
再用 AVFoundation 做最权威的判定：

```text
swift work/poc/tools/cam_list.swift   → video devices = 0
```

**联网查到确切芯片**：`0x0ac8:0x301b` = **ZC0301（Vimicro / Z-Star）**。上游社区项目
[amitv87/ZC0301](https://github.com/amitv87/ZC0301)（Linux `gspca/zc3xx` 的用户态移植）公开的
描述符打印**与本机实测完全一致**：

```text
Manufacturer: Vimicro Corp.   Product: PC Camera
Interface[0] alt 0..7: VENDOR_SPEC FF.FF.FF
Endpoint[0]: 0x81 IN ISOCHRONOUS 0..896 bytes
Endpoint[1]: 0x82 IN INTERRUPT 8 bytes
```

其原话：**"There is no UVC here"**——桥接与传感器全靠厂商私有控制传输，视频走等时端点，
传感器要探测才知道（**上游那颗**探到 Hynix HV7131R；本项目这颗的实测见 §0.3，**未能探出**）。

**对本项目的结论（不变，理由更硬）**：

- **macOS 原生不可用**：不是权限/配置问题，而是这类设备**不会出现在 AVFoundation 相机列表**里，
  走不了系统相机路径 ⇒ 视觉链路必须换**真 UVC**。
- **但它不算废品**：上游用户态驱动在 **macOS 上验证过可串流**（libusb；WebUSB 在 macOS 的 Chromium 上也可）。
  代价是要装 `libusb + python-libusb1`（本机**没有 brew**）或走 `Chrome + WebUSB`，
  与本项目「USB 免驱」硬约束（[[architecture]] §1.1）冲突，**不作为项目路线**。

复现工具：`work/scripts/usb_desc_probe`（描述符）、`work/poc/tools/cam_list.swift`（AVFoundation 设备数）。

### 0.3 2026-10-05 复核：macam 走不通；上游用户态驱动"能通、不能出图"

起因：用户提出「macam 可以支持老型号摄像头，能不能试」。实测结论与过程如下。

**一、macam 本身：架构层面就不可用**

| 版本 | 情况 |
| --- | --- |
| 原版 macam（webcam-osx.sourceforge.net，2006–2009） | 32 位 QuickTime **VDIG**（video digitizer）组件 + 偏好面板，支持到 Mac OS X 10.6；本项目主机是 **Apple M4 / macOS 27 / arm64**，这类组件**连加载都不可能**（无 32 位运行时，Rosetta 也不模拟 32 位） |
| [smokris/macam64](https://github.com/smokris/macam64)（2020，移植到 10.15） | 去掉 QuickTime/GUI，只产出一个静态库；**`CMakeLists.txt` 把 `cameras/ZC030xDriver.m`（正是这颗的驱动）列在 "Build errors" 注释里**，且 `-march=x86-64`；作者自述只测过 Intel QX3 ⇒ 同样不可用 |

**二、但 macam 的设备表给出了桥接芯片的旁证**：`utilities/USB_VendorProductIDs.h` 里
`VENDOR_Z_STAR_MICRO 0x0ac8` / `PRODUCT_GENERIC_ZC0301B 0x301b // ZC0301P`，
`cameras/ZC030xDriver.m` 对应条目名 `Generic ZC0301P Webcam` ⇒ **桥接 = ZC0301P**（旁证，非唯一依据）。

**三、实机尝试（上游用户态驱动）**：本机没有 brew，走「libusb 1.0.27 源码直接编 arm64
`libusb-1.0.0.dylib` + `pip install libusb1`」，跑 [amitv87/ZC0301](https://github.com/amitv87/ZC0301)
的 `zc3xx_capture.py`（联网经用户提供的代理）：

| 步骤 | 实测结果 |
| --- | --- |
| `probe` | 桥接 `ZC301` **识别成功**；**传感器未识别**，落到兜底 `SENSOR_TAS5130C`；寄存器 `0002=00 0008=11 0010=02 0011=00`，`0180=USBErrorTimeout` |
| `snap`（320×240） | **能建立等时流、能收到帧**，但每帧都是 2093 字节的**纯黑图**（5 帧字节数完全一致） |
| `--force-sensor` 逐个试 15 种 | 只有兜底 `TAS5130C` 能出帧（黑）；其余全部失败，其中一次 EP0 报 `LIBUSB_ERROR_PIPE` |
| 之后 | 摄像头**从 USB 总线上掉线**（`ioreg` 与 libusb 都查不到），数秒后**自行重新枚举**回来 |

**四、交叉验证（不依赖 libusb 的 IOKit 探针）**：另写 `work/scripts/zc0301_probe.m`，复刻内核
gspca 的 `probe_sensor`（2 线探测 + 3 线探测 + 桥接版本字反查），并先手动 `SET_CONFIGURATION(1)`
（macOS 自己不会给全 0xFF 设备做这一步，否则控制传输直接失败）：

- 控制传输**读写自检通过**：写 `R08B=0x5a` 读回 `0x5a`；桥接寄存器快照有真实值
  （`R0003..R0006 = 0280/01e0`，即 640×480 窗口）。
- 但传感器通道（桥接寄存器 `0x90`–`0x96` 的 I2C 主控）**全程读回 0**；桥接版本字 `0xc400`
  不在 `chipset_revision_sensor` 表内 ⇒ **传感器无应答**。

**结论**：

- **桥接芯片 = ZC0301P（确定）**；**传感器型号 = 未确定**。§0.2 写的 "Hynix HV7131R" 是**上游那颗**
  的探测结果；本项目这颗用两条独立实现都探不到，**不能沿用**该结论。
- **macam 这条线判死**：原版架构过时，64 位移植恰好不支持该驱动。
- 上游用户态驱动在**本机**只能做到「桥接识别 + 收到帧 + 全黑」，且寄存器操作容易把设备打到掉线
  ⇒ **依然不可用于视觉链路**，与 §0.1 的结论一致：**换真 UVC**。

复现工具（均在 `work/`，不入库）：`work/scripts/zc0301_probe.m`（IOKit 探针）、
`work/refs/ZC0301-main/`（上游驱动源码）、`work/tools/libusb-1.0.0.dylib`（本地编译的 arm64 libusb）。

### 0.4 2026-10-09 复核：换上的真 UVC 摄像头 ✅ 四层全通过

用户换上一颗新摄像头（`HDI Webcam USB`）后，在目标主机（Mac mini / Apple Silicon / **macOS 27.0.1**）
重走四层判定，**L1–L4 全通过**——这颗**可以**用于视觉链路：

| 层 | 实测 |
| --- | --- |
| **L1 枚举** | `HDI Webcam USB`，VID:PID **`0x145f:0x02ec`**，Location ID `0x02122000`（与老 ZC0301 同一个口），`bcdUSB=0x0200`（USB 2.0 高速） |
| **L2 系统相机** | `SPCameraDataType` 出现 `HDI Webcam USB`，Model ID `UVC Camera VendorID_5215 ProductID_748` |
| **L3 描述符（决定性）** | 设备级 **`class=0xEF sub=0x02 proto=0x01`（IAD 复合设备）**；4 个接口：IF#0 `class=0x0e sub=0x01`（VideoControl，中断 EP `0x83`/16B）、IF#1 `class=0x0e sub=0x02`（VideoStreaming，**批量** EP `0x85`/512B；含 1 个无压缩 Format + 11 个无压缩 Frame、1 个 MJPEG Format + 12 个 MJPEG Frame、类特定 still-image）、IF#2 `0x01/0x01`（AudioControl）、IF#3 `0x01/0x02`（AudioStreaming，等时 EP `0x84`/192B）⇒ **UVC 视频 + UAC 内置麦克风** |
| **L4 出帧** | AVFoundation 共 3 个视频设备，这颗是 **index 0**；抓帧成功且**是真实画面**（非黑图）：默认档 **1920×1080@25**，钉格式后 **1280×720@30** |

**为什么这颗能用、老 ZC0301 不能用**：设备级类 `0xEF`（IAD）正是 macOS
`AppleUSBHostCompositeDevice` 会匹配的类型（见 §6），接口层再声明 UVC `0x0E` ⇒ 系统照常
`setConfiguration` 并绑定 UVC 驱动，设备出现在相机列表里。老那两颗设备级与接口全 `0xFF`，
没有任何驱动匹配，接口永远不出现。

**支持格式**（AVFoundation 视角，同一分辨率常有两档像素格式）：

| 分辨率 | `420v`（NV12） | `yuvs`（YUY2） |
| --- | --- | --- |
| 160×120 / 320×240 / 352×288 / 640×480 / 800×600 / 1280×720 / 1280×960 / 1920×1080 | 30 / 25 / 20 / 15 / 10 / 5 fps 可选 | 20 fps（1280×720、1024×576、1920×1080 只有 5 fps） |
| 640×360 | 25 fps | 20 fps |
| 1024×576 | 30 fps | 5 fps |

⇒ **要高帧率就走 NV12/MJPEG 档，别选 YUY2**（YUY2 在高分辨率上掉到 5fps）。

**采集坑（本机实测）**：

- `AVCaptureSession.sessionPreset = .high` 会**覆盖** `device.activeFormat`——先设 1280×720
  仍然出 1920×1080。
- macOS 上 `AVCaptureSessionPresetInputPriority` 被标为**不可用**（编译期 `API_UNAVAILABLE(macos)`）。
  可行做法是**在 session 运行中再钉一次 `activeFormat`**（之后 preset 即按输入格式走），
  实测 1280×720 能拿到 1280×720@30。
- **画面是倒装的**（抓到的帧上下颠倒 180°）⇒ 装机时按正确朝向固定，或在采集侧做旋转。
- **麦克风抢了默认输入**：`SPAudioDataType` 里 `HDI Webcam USB` 带 `Default Input Device: Yes`
  （2 输入通道 / 48kHz / USB 传输）——插上后它取代了原来的默认输入设备。走系统 ASR 时要留意选错输入源。
- **带宽就是天花板（2026-10-09 补测）**：这颗摄像头的 1280×720 / 1920×1080 **只有未压缩档**
  （`420v` = NV12 语义、`yuvs` = YUY2 且掉到 5fps），**没有 MJPEG**。1280×720@30 的 `420v` 约
  1280×720×1.5B×30 ≈ **41.5MB/s（332Mbps）**，贴着 USB2 的实际可用带宽 ⇒ 出帧**时好时坏**
  （同一条命令连跑两次：先等帧超时，紧接着再开 0.9s 成功；旁边再挂上 iPhone Contiguity Camera
  争用时会持续不出帧）。**抓单帧不需要满帧率**：把 `activeVideoMinFrameDuration` 钉到 1/10
  （`--fps 10`）就把带宽压到约 1/3；更稳的是**干脆不钉格式**，用系统协商的默认档。

复现工具：`work/scripts/uvc_capture.swift`（探针原型，不入库）；**已升级成项目里的原生桥**
`wallyd/scripts/uvc_capture.swift`（`list` / `capture` / `request-permission`，stdout 一行 JSON，
由 robotd 的 `camera.capture` 调用）。早期抓帧留在 `work/eval/uvc_frame_*.jpg`（含人像，不入库）。

## 1. 适用范围

- 买摄像头前/到货后的**验货**：是不是真 UVC。
- 插上摄像头系统不认时的**定位**：卡在哪一层。
- 给视觉链路（`camera.capture()` → `vision.vqa()`）**准备采集通道**时的配置与踩坑对照。

不覆盖：相机（手机/微单）经由虚拟相机或采集卡的接入方案，见
[[architecture|架构设计]] §3.2 与 [[hardware-selection|硬件选型]] §5。

## 2. 四层判定模型

逐层验证，任意一层不通过就不必继续往下：

| 层 | 要回答的问题 | 手段 | 通过标准 |
| --- | --- | --- | --- |
| **L1 物理/枚举** | USB 认到设备了吗 | `system_profiler SPUSBDataType` / `ioreg -p IOUSB` | 出现设备条目（含 VID:PID、Location ID） |
| **L2 驱动/协议** | 系统把它当相机了吗 | `system_profiler SPCameraDataType` | 出现 Camera 段与设备名 |
| **L3 接口类（决定性）** | 它到底是不是 UVC | 读配置描述符（§4 探针） | 存在 `bInterfaceClass=0x0E` 接口 + 类特定描述符 |
| **L4 出帧** | 真能抓到画面吗 | AVFoundation 枚举 + 抓一帧（§3） | 设备在列表里且能落盘一张 JPEG |

常见误判：只看 L1 就以为"系统支持了"；或把 L2 为空当成"设备坏了"——**沙箱或未授权进程
下 L2/L4 一律为空**，见 §3 的注意事项。

## 3. 快速检查（不写代码）

```bash
# L1 USB 枚举
system_profiler SPUSBDataType

# L2 系统相机列表（有输出才算被系统认作相机）
system_profiler SPCameraDataType

# L4 AVFoundation 设备清单（含设备索引，MacPorts 的 ffmpeg 路径）
/opt/local/bin/ffmpeg -hide_banner -f avfoundation -list_devices true -i ""

# L4 抓一帧（命令里的 "0" 是设备索引，内置 FaceTime HD 相机 = 0）
/opt/local/bin/ffmpeg -f avfoundation -framerate 30 -i "0" -frames:v 1 -y work/frame.jpg
```

本机实测的通过样例（L2 与 L4）：

```text
Camera:
    FaceTime HD Camera:
      Model ID: Apple Camera VendorID_0x106B ProductID_0x1570

AVFoundation video devices:
  [0] FaceTime HD Camera
  [1] Capture screen 0
```

> ⚠️ **注意事项（踩过的坑）**：在受限沙箱或未授权的进程里，上面两条命令会返回**空列表**
> （连内置相机、内置麦克风都不出现），看起来像"设备不存在"。实测同一台机器：沙箱内
> `SPCameraDataType` 与 AVFoundation 均为空，跳出沙箱后立刻出现 `FaceTime HD Camera`。
> 所以 L2/L4 必须在**真实终端**里跑，并且首次要在「系统设置 → 隐私与安全性 → 摄像头」
> 给承载采集的进程授权。授权缺失与设备损坏的表现完全一致，不要据此下结论。

## 4. 决定性判定：读配置描述符

L2 为空只能说明"系统没认"，区分不了三种原因：**非 UVC** / **权限未授权** / **沙箱限制**。
唯一能定性的是接口类，需要直接向设备发 `GET_DESCRIPTOR`。

工具：`work/scripts/usb_desc_probe.m`（本次排查写的临时探针，按仓库规范放在 `work/`，
**不入库**；依赖 Command Line Tools 的 clang）。它按 `locationID` 定位 `IOUSBHostDevice`，
用 `descriptorWithType:`（只读控制传输）取回完整配置描述符，打印设备类、接口类/子类/协议、
端点与类特定描述符。

```bash
# 编译（一次性）
clang -fobjc-arc -Wno-deprecated-declarations -framework Foundation -framework IOKit \
  -framework IOUSBHost -o work/scripts/usb_desc_probe work/scripts/usb_desc_probe.m

# 运行：参数是 §3 L1 里的 Location ID
./work/scripts/usb_desc_probe 0x14100000
```

判据：

| 观察到的描述符 | 判定 | 处置 |
| --- | --- | --- |
| 有 `class=0x0e` 接口（常伴 `CS_INTERFACE`/0x24 类特定描述符） | **UVC，可用** | 继续 L4，并按 §7 配置 |
| 接口全是 `class=0xff` | **私有协议，macOS 无解** | 换设备（见 §6 的例外） |
| 设备类 0xFF 但接口是 0x0E | UVC，可用 | 设备级类不参与 UVC 判定 |

> ⚠️ 探针需要打开 USB 用户客户端，**必须跳出沙箱运行**。沙箱内会报
> `kIOReturnNotPermitted`（`0xe00002e2`）；若报 `Failed to create IOUSBHostObject`，
> 说明设备已被别的进程独占（我们把设备探测过程也实测过，浏览器 WebUSB 会持有该客户端）。

## 5. 实测案例：非 UVC 摄像头的画像（反面教材）

两颗同型号摄像头（换了设备后厂商字符串与端点包大小有差异，说明确实是两个物理设备）：

| 项 | 实测值 |
| --- | --- |
| 名称 / 厂商 | `PC Camera` / Vimicro Corp.（第二颗为 Z-Star Corp.） |
| VID:PID | `0x0ac8:0x301b` |
| 设备类 | `0xFF`（厂商自定义），`bcdUSB=0x0110`（USB 1.1 全速），160mA，1 个配置 |
| 接口 | 1 个接口 × **8 档 alternate setting**，**全部** `class=0xFF sub=0xFF proto=0xFF` |
| 端点 | `0x81` 等时 IN（各档最大包 0 / 128 / 192 / 256 / 384 / 512 / 768 / 896（另一颗 1023）字节）；`0x82` 中断 IN 8 字节 |
| 系统侧 | L1 通过；L2 为空；无任何视频驱动绑定（子节点只有 `AppleUSBHostLegacyClient`），设备始终处于"未配置"状态 |

**特征识别**：一个接口 + 多档 alternate setting（带宽档位）+ 等时端点 + 全 0xFF，
就是私有协议摄像头的典型画像。这批芯片（Vimicro/Z-Star 那一代）在 Linux 上靠 gspca 的
非 UVC 驱动出图，macOS 侧没有任何对应驱动。

## 6. 为什么 Windows 上"免驱"、macOS 上不行

两个系统的**枚举顺序不同**，这是理解整件事的关键：

- **Windows**：USB 栈无条件给设备选配置、做通用枚举，再按硬件 ID 找驱动。这类老摄像头
  的厂商驱动在 Windows Update 里，插上会被静默装好——用户视角就是"免驱"。
- **macOS**：设备要先等到**设备级驱动匹配**才会 `setConfiguration`。内置的
  `AppleUSBHostCompositeDevice` 只匹配这几类设备：`0x11`(17) / `0x07`(7) × 2 /
  `0xEF`(239，IAD) / `0x00`（类在接口层）——**不含 0xFF**。于是私有协议设备没人配置它，
  接口永远不出现，相机栈（CoreMediaIO/AVFoundation）也就永远看不到它。

**在 Windows 上反查是否真 UVC**：设备管理器 → 该摄像头 → 属性 → 驱动程序 →
「驱动程序提供程序」。写 `Microsoft` / `usbvideo.sys` 才是真 UVC；写厂商名
（Vimicro / Z-Star 等）说明是私有协议 + 厂商驱动，与 §5 的画像一致。

> 例外：若确实要用这类非 UVC 摄像头，可行路径只有"换平台"——接在 Linux 主机
> （gspca 驱动）上，再把画面经局域网推给 Mac。它违反本项目"Mac mini 单机、零专用工具"
> 的定位，仅作为备选记录，不作为方案。

## 7. 配置：选型 / 授权 / 采集

### 7.1 选型（本项目结论）

- **必须 UVC**：到货先走 §3 + §4 验一遍，再装上云台。见 [[hardware-selection|硬件选型]] §5。
- 720p（¥20–40）对 VLM 识别已够用，1080p（¥40–90）更清晰；云台承载时越轻越好。
- 深度相机（RealSense/OAK-D）超预算，本期不做。

### 7.2 权限（macOS TCC）

- 「系统设置 → 隐私与安全性 → 摄像头」给**承载采集的进程**授权：终端、MCP Server，
  或 `launchd` 拉起的可执行文件（后者在首次调用时才会出现在列表里）。
- 未授权 = 枚举为空 = 与"没插"同表现，见 §3 注意事项。

### 7.3 采集参数

- OpenCV：`cv2.VideoCapture(index)`（macOS 下自动走 AVFoundation 后端）；
  分辨率用 `CAP_PROP_FRAME_WIDTH/HEIGHT` 显式设置，默认档通常不是 1080p。
- **设备索引会变**：内置相机 = 0，插上 USB 摄像头后通常是 1；要稳定就别写死索引，
  用 `ffmpeg -list_devices` 或按设备名匹配。
- 喂给 VLM 前缩到**长边 768–1024px**、JPEG 质量 ~80：分辨率不是瓶颈，token 与延迟才是。
- 帧不落进知识库：写 `work/` 或临时目录（项目约束是数据不出本地/局域网）。

### 7.4 与 VLM 链路的衔接

```text
触发（Agent 主动调用 / 定时 / 帧差）
   → camera.capture()     单帧 JPEG
   → 缩放到长边 ≤1024px
   → vision.vqa(img, q)   MLX + Qwen2.5-VL-3B
   → 文本回答回 Agent
```

- **不要把视频流喂 VLM**：本地 VLM 单帧约 1–3s（24G 统一内存），见
  [[risk-assessment|风险清单]] R4。正确形态是"按需看一眼"，想让机器人移动中随时知道
  前方状况时，先用便宜的预筛（帧差/亮度）决定何时送帧。
- 接口对齐 [[architecture|架构设计]] §5.1 的 `camera`/`vision` 模块与 §4.4 的 MCP 桥。

## 8. 排错对照表

| 症状 | 可能原因 | 处置 |
| --- | --- | --- |
| L1 为空（USB 里也没有） | 线材/接口/供电不足 | 换口、直连不用 hub、核对是否满足 160mA 供电 |
| L1 有、L2 为空 | 非 UVC（0xFF）；或权限未授权；或沙箱限制 | 跑 §4 探针定性；确认在真实终端并已授权摄像头 |
| L2 有、L4 抓不到帧 | 设备被别的进程占用（浏览器 WebUSB 等）；索引写错 | 关掉占用进程；用 `-list_devices` 确认索引 |
| 探针报 `kIOReturnNotPermitted` | 沙箱未放行 | 跳出沙箱运行 |
| 探针报 `Failed to create IOUSBHostObject` | 设备已被独占 | 让占用者释放 |
| 抓帧命令参数正确但没图 | TCC 未授权 / 设备索引变了 | 授权摄像头；重新枚举设备 |

## 9. 供 Agent / MCP 调用的接口建议

把上面的判定固化成工具，Agent 就能自己"验货 + 抓帧"：

- `camera.list_devices() -> [{index, name, uvc: bool}]`
  （AVFoundation 枚举 + §4 描述符判定的合并结果）
- `camera.probe(vid, pid) -> {device_class, interfaces:[{class, subclass, protocol}], is_uvc}`
  （§4 探针的封装，便于批量验货）
- `camera.capture(index=0, width=1280) -> path`（单帧，供 VLM 调用）

## 10. 待核实与后续

- **待核实**：这颗摄像头的**传感器型号**（桥接已确定 ZC0301P）。macOS 侧两条独立实现（IOKit 探针、
  上游 libusb 驱动）都探不到传感器应答；要确认得换平台——在 Linux 主机上跑 gspca `zc3xx` 看
  dmesg 的传感器探测结果（见 §0.3）。
- ~~**待核实**：UVC 摄像头到货后的实测数据（设备索引、默认分辨率 / 帧率）~~ →
  **已完成 2026-10-09，见 §0.4**：index 0、默认 1920×1080@25、720p@30 可取、画面倒装、麦克风成为默认输入。
  供电上它不吃 12V / 5V 动力轨——摄像头经 USB 由 Mac mini 供电（见 [[electrical-architecture|电气系统架构]] §3）。
- **待确认**：是否把排查探针从 `work/` 收进 `wallyd/scripts/`
  （`work/scripts/usb_desc_probe.m` 判 UVC、`work/scripts/uvc_capture.swift` 抓帧——收进仓库
  才便于复现，但它们是排查工具而非控制脚本，需要决定归属；见 §9 的工具化建议）。
- **待确认**：是否需要"多摄像头同时枚举/切换"（内置 + UVC），影响 `camera` 模块接口设计。
- **待核实**：其它 macOS 版本（12/13+）上 `AppleUSBHostCompositeDevice` 的匹配表是否
  相同；本结论基于 macOS 11.7.11。

## 来源与实测记录

- 2026-10-09 本机实测（Mac mini / Apple Silicon / macOS 27.0.1，真 UVC 摄像头 `HDI Webcam USB`）：
  `system_profiler SPCameraDataType` / `SPUSBHostDataType` / `SPAudioDataType`、
  `work/scripts/usb_desc_probe 0x02122000` 描述符 dump、`work/scripts/uvc_capture.swift` 格式枚举与抓帧。
- 2026-09-26 ~ 09-27 本机实测（MacBookPro11,2 / macOS 11.7.11）：
  `system_profiler SPUSBDataType`、`system_profiler SPCameraDataType`、
  ffmpeg `-f avfoundation -list_devices`、`work/scripts/usb_desc_probe` 描述符 dump。
- 系统侧依据：`/System/Library/Extensions/IOUSBHostFamily.kext/Contents/PlugIns/`
  下 `AppleUSBHostCompositeDevice.kext` 的匹配表；`IOUSBFamily.kext` 下
  `IOUSBCompositeDriver.kext` 的匹配表；`CoreMediaIO.framework` 内的
  `AppleCamera.plugin`。

## 相关页面

- [[hardware-selection|硬件选型与采购方案]] §5（摄像头选型）
- [[architecture|架构设计文档]] §3.2 / §4.4 / §5.1（camera 与 vision 模块、MCP 桥）
- [[risk-assessment|风险清单]] R4（本地 VLM 实时性）
- [[wallyd/README|Mac mini 移动机器人]]（项目主页）

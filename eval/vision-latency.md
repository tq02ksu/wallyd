---
title: 视觉延迟实测 — VLM 与系统检测器（2026-10-06）
type: project
description: 在目标机（Mac mini Mac16,10 / Apple M4 / 24GB）上用 COCO val2017 公开图实测两条感知路径的单帧延迟：MiniCPM-V 4.6 4bit（MLX）0.84s/帧、macOS 自带 Vision 4–20ms/次（动物检测 4–7ms 带框）；据此确认「实时闭环用检测器、语义问答用 VLM」的分工，并给出 YOLO 的引入判据与两个实测坑（系统代理劫持 localhost、内存口径 16 vs 24GB 冲突）。
tags: [project, robot, vision, eval, latency]
domain: robot
project: macmini-robot
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-06T08:50:00+08:00 }
relations:
  - predicate: part-of
    target: /README.md
  - predicate: depends-on
    target: /docs/architecture.md
  - predicate: depends-on
    target: /docs/risk-assessment.md
---

# 视觉延迟实测 — VLM 与系统检测器（2026-10-06）

> 起因：设计里把视觉分成「快（检测器）」与「慢（VLM）」两条路径（[[architecture|架构设计]] §10.3），
> 但延迟数字一直是"待实测"。本次用**公开数据**在**目标机**上把两组数字补上。
> 复现方式见 [[README|评测脚本使用说明]]。

## 0. 结论

1. **快路径比 VLM 快约 100–200×**（≈5ms vs ≈840ms）——"实时闭环用检测器、语义问答用 VLM"这条分工
   从纸面推论变成**有数字支撑**。
2. **YOLO 暂时不需要**：macOS 自带 Vision 已免费提供人 / 脸 / 动物（带框）/ 矩形 / 显著性，
   跑在 4–20ms。只有需要**系统给不出的类别（通用 80 类）**时才值得引入 YOLO，且要另算
   Ultralytics 的 AGPL-3.0 许可成本。
3. VLM 单帧 **0.84s**（短回答，≈20 tok/s）；空载预热只要 **2.1s**，所以"按需启动 + 抽帧调用"
   在延迟上完全可接受，不必把它常驻在逐帧回路里。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 机器 | **Mac mini `Mac16,10`**，Apple M4，10 核（4P+6E），**内存 24 GB** |
| 系统 | macOS 27.0.1（build 26A434），arm64 |
| 慢路径运行时 | `mlx_vlm.server`（`mlx 0.32.2` / `mlx-vlm 0.7.1`），模型 `MiniCPM-V-4.6-4bit`（2.0GB，本地权重） |
| 快路径运行时 | macOS 自带 Vision framework（`swiftc -O` 编译的 CLI） |

## 2. 测试数据（公开）

**COCO val2017** 五张图（`http://images.cocodataset.org/val2017/<id>.jpg`）：
`000000039769`（两只猫）、`000000000139`（起居室）、`000000000285`（熊）、`000000000632`（卧室）、
`000000000785`（滑雪者）。

> 图缓存在项目工作区 `work/eval/`（二进制不入库）；本文只记来源 URL，随时可重新下载。
> 仅测**延迟**，未测精度——COCO 的标注可用于算 mAP，留作后续。

## 3. 结果

单位 ms（`first` = 首次调用，含模型冷加载；`mean/min/max` = 预热后 5 张图各 5 次）：

| 路径 | 请求 | first | mean | min / max |
| --- | --- | --- | --- | --- |
| 慢 · VLM | MiniCPM-V 4.6 4bit，prompt「用一句话描述这张图片」，`max_tokens=32` | 3290（服务预热） | **840** | 780 / 900 |
| 快 · 分类 | `VNClassifyImageRequest`（ImageNet 1000 类） | 61.5 | 9.0 | 5.6 / 12.7 |
| 快 · **动物检测（带框）** | `VNRecognizeAnimalsRequest` | 324.6 | **5.7** | 3.4 / 7.1 |
| 快 · 人体 | `VNDetectHumanRectanglesRequest` | 3.7 | 6.0 | 3.3 / 7.3 |
| 快 · 人脸 | `VNDetectFaceRectanglesRequest` | 4.0 | 6.1 | 3.1 / 8.3 |
| 快 · 矩形 | `VNDetectRectanglesRequest` | 6.0 | 6.0 | 4.5 / 7.3 |
| 快 · 物体显著性 | `VNGenerateObjectnessBasedSaliencyImageRequest` | 5.8 | 7.1 | 5.0 / 8.7 |
| 快 · 前景实例掩码 | `VNGenerateForegroundInstanceMaskRequest` | 107.0 | 15.4 | 12.6 / 20.8 |

**VLM 侧细节**：10 次请求（5 图 × 2 次）输出 14–18 token，全部落在 **780–900ms**，抖动极小；
按实测 **≈20 tok/s** 外推，**100 token 的回答 ≈5s**。服务空载预热 2.1–3.1s。
识别内容均正确（如"两只猫在粉红色的毯子上睡觉，其中一只旁边放着一个遥控器"）。

## 4. 怎么读这些数字

- **VLM 是"慢而通用"**：1–3s 的说法对**短回答偏保守**（实测 0.84s）、对**长回答偏乐观**（100 token ≈5s）。
  它的价值在开放式理解，**绝不能进控制回路**（控制回路要 10–50Hz，见 [[architecture|架构设计]] §10.5）。
- **系统检测器是"快而专用"**：4–20ms ⇒ 50–250 fps，够 `Nav` 避障 / 找目标用；但类别受限
  （人体 / 人脸 / 动物 / 矩形 / 显著性 / 前景掩码），**没有通用 80 类**。
- **YOLO 的引入判据**：只有当需要系统给不出的类别（如"杯子""充电底座""门"）时才引；届时优先
  CoreML 导出跑 ANE，并注意 Ultralytics 系权重的 **AGPL-3.0**（套件分发要留意）。
- **VLM 按需抽帧可行**：预热 2.1s + 0.84s/帧，比"常驻逐帧"划算得多——抽帧策略在延迟上站得住。

## 5. 两个实测坑（都值得写进实现）

1. **系统 HTTP 代理会劫持 `127.0.0.1`**。本机开着 `192.168.0.133:7897` 系统代理时，Python `urllib`
   把 localhost 请求也发给代理，返回 **502 Bad Gateway**，而 `curl`（只认环境变量）一切正常——
   极易误判成"模型服务挂了"。调本地服务必须显式绕过代理。
2. **内存口径冲突（待确认）**。硬件直接读出 **24GB**（`hw.memsize` 与 `system_profiler` 一致），
   而 [[model-selection|模型选型]] §0 记录的是"从 24GB 下调到 16GB"。两说并存、未覆盖，
   待确认后再统一（影响可用模型规模与"共存余量"的判断）。

## 6. 复现

```bash
# ① 取公开测试图（缓存进项目工作区 work/eval，不入库；命令在项目根目录执行）
mkdir -p work/eval && (cd work/eval && curl -fsS -O http://images.cocodataset.org/val2017/000000039769.jpg)

# ② 快路径：系统 Vision
cd eval && swiftc -O -o /tmp/vision_bench vision_bench.swift
WARMUP=1 ITERS=5 /tmp/vision_bench ../work/eval/0*.jpg

# ③ 慢路径：MiniCPM-V（需在沙箱外跑）
BENCH_REPS=2 BENCH_MAX_TOKENS=32 sh eval/run_vlm_bench.sh
```

## 7. 局限与下一步

- **只测了延迟，没测精度**：COCO val2017 带标注，可扩到全量算 mAP，用来判断"系统 Vision 够不够、
  要不要上 YOLO"。
- **只测了单模型**：主 LLM + VLM + ASR + TTS **共存**时的内存 / 延迟余量仍未测
  （[[risk-assessment|风险清单]] R4 的剩余项）。
- 未测**视频流**表现（连续帧、编解码、丢帧）——本次是单帧请求。

## 相关页面

- [[README|评测脚本使用说明]]
- [[architecture|架构设计（C4）]] §10.3 / §10.5
- [[risk-assessment|可行性评估与技术风险清单]] R4
- [[model-selection|LLM / TTS / ASR 模型选型]]

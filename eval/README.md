---
title: 视觉评测脚本 — 使用说明
type: project
description: 两个评测脚本怎么跑：系统自带 Vision 的快路径基准（swift，零依赖）与 MiniCPM-V 的慢路径基准（python，连本地 MLX 服务）；含公开测试数据的取用方式与两个必踩的坑。
tags: [project, robot, vision, eval, usage]
domain: robot
project: macmini-robot
sources: []
generated: { by: codex/deepseek-v4-pro, at: 2026-10-06T08:50:00+08:00 }
---

# 视觉评测脚本 — 使用说明

> 结果本身见 [[vision-latency|视觉延迟实测（2026-10-06）]]。这里只讲怎么复现。
> 命令都在**项目根目录**（`<wallyd-root>/`）执行；只需要 `swiftc` 与 `/usr/bin/python3`。

## 0. 测试数据（公开，不入库）

用 **COCO val2017** 的图（公开数据集，随便挑几张即可）：

```bash
mkdir -p work/eval && cd work/eval
export https_proxy=http://192.168.0.133:7897 http_proxy=http://192.168.0.133:7897   # 按需
for id in 000000039769 000000000139 000000000285 000000000632 000000000785; do
  curl -fsS -o "$id.jpg" "http://images.cocodataset.org/val2017/$id.jpg"
done
```

> 图是**二进制下载物**，按本项目 [AGENTS.md](../AGENTS.md) 留在工作区 `work/eval/`（不入库）；仓库里只记这一行 URL。
> 想扩到全量：COCO val2017 共 5000 张 + 标注，可用来算 mAP（本目录目前只测**延迟**）。

## 1. 快路径：系统自带 Vision（零下载、零许可）

```bash
cd eval
swiftc -O -o /tmp/vision_bench vision_bench.swift
WARMUP=1 ITERS=5 /tmp/vision_bench ../work/eval/0*.jpg
```

输出 CSV：`image,case,first_ms,mean_ms,min_ms,results`（`results` = 该请求返回的结果数）。
覆盖的请求：分类、动物检测（带框）、人体、人脸、矩形、显著性、前景实例掩码。
`first_ms` 是**首次调用**（含模型冷加载，可能是均值的好几倍），`mean/min` 是预热后的稳定值。

## 2. 慢路径：MiniCPM-V（MLX，需要 Metal 与本地权重）

```bash
BENCH_REPS=2 BENCH_MAX_TOKENS=32 sh eval/run_vlm_bench.sh
```

脚本会：① 若 `127.0.0.1:8080` 已有服务就复用，否则起一个并**计加载时间**；② 对每张图发一次
OpenAI 兼容请求并计时；③ 关掉自己起的服务。

- 前置：`~/workspace/bot`（模型 + `.venv`，见 [[model-selection|模型选型]]）；可用 `BOT=`、`MINICPM_MODEL=`
  覆盖，或直接用 `MINICPM_BASE_URL=` 指向已有服务。
- **必须在沙箱外跑**（MLX 要 Metal）。跑完把服务关掉，否则会一直占着 8080。
- 只跑指定图：`sh eval/run_vlm_bench.sh work/eval/000000039769.jpg`。

## 3. 两个坑（都会让你以为"模型坏了"）

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| VLM 请求返回 **502 Bad Gateway**，服务日志里却什么都没有 | 本机开着系统 HTTP 代理时，Python `urllib` 会把 `127.0.0.1` 也发给代理（`curl` 只看环境变量，反而正常） | `vlm_bench.py` 已显式 `ProxyHandler({})`；自己写客户端时照做 |
| 启动就报 `No Metal device available` | 在受限沙箱里跑 MLX | 沙箱外运行（同 [camera-detection](../docs/spec/camera-detection.md) §3 的权限类问题） |

## 4. 脚本清单

| 文件 | 说明 |
| --- | --- |
| `vision_bench.swift` | 系统 Vision 七种请求的单帧延迟基准（swiftc 编译，无第三方依赖） |
| `vlm_bench.py` | 对本地 MLX 服务发图、计时、汇总吞吐（只用标准库） |
| `run_vlm_bench.sh` | 起服务 → 跑 `vlm_bench.py` → 关服务的一键脚本 |

## 相关页面

- [[vision-latency|视觉延迟实测（2026-10-06）]]
- [[architecture|架构设计]] §10.3（两条感知路径）
- [[risk-assessment|风险清单]] R4

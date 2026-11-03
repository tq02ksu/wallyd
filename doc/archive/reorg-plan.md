---
title: doc/ 文档整理方案（体检报告 + 四阶段计划）
type: project
description: 对 doc/ 全部 28 篇文档做一次体检，给出不带目录重构的整理方案：问题清单（索引漂移、主题重复、校验不达标、断链、无时效分区）、目标结构（4 hub + 分类前缀）、P0–P3 四阶段执行步骤与验收命令，含三条待用户拍板的决策项。
tags: [project, robot, docs, plan]
aliases: [文档整理方案, doc 体检, 文档治理]
domain: robot
project: macmini-robot
sources: []
generated: { by: workbuddy/claude, at: 2026-10-19T08:10:00+08:00 }
status: draft
relations:
  - predicate: part-of
    target: /projects/robot/README.md
  - predicate: depends-on
    target: /projects/robot/doc/index.md
  - predicate: about
    target: /projects/robot/AGENTS.md
---
> ⚠️ **本文成文于 2026-10-19 之前**：文中提到的 `software-architecture.md` 与 `software-design.md`
> **已于 2026-10-19 并入 [`architecture.md`](../architecture.md)**（按 C4 重组），两份旧文件已删除。
> 本文保留为当时的体检存证，**不要据此去找那两个文件**。

# doc/ 文档整理方案

> 状态：**方案，未动任何文件**（用户要求先看方案）。
> 体检时点：2026-10-19｜方法：逐文件读 frontmatter / 标题层级 / 双链 / 交叉引用，并跑校验器取基线。

## 0. 一句话

`doc/` 的问题**不是错**，而是**长太快没分层**：28 篇文档挤在同一层，索引没跟上，同主题内容散在多处，
且「设计文档 / 一次性核实 / 未来方案 / 运行手册」四种性质的东西混在一起，读者分不清哪份是当前口径。

**结论：不需要动目录结构**（子目录化会打断 100+ 处 `[[双链]]` 和 `src/`、`firmware/` 里的路径引用），
用「**4 个 hub 页 + 两条硬纪律**」就能收敛。

## 1. 体检基线

### 1.1 现状盘点

| 分类 | 篇数 | 文件 |
| --- | --- | --- |
| 总体 / 产品 | 4 | `architecture` `product-positioning` `risk-assessment` `hardware-selection` |
| 软件 | 6 | `software-architecture` `software-design` `communication-protocol` `voice-architecture` `layers-and-modules` |
| 硬件 / 电气 | 5 | `electrical-architecture` `power-architecture` `stepper-wiring` `wiring-connectors` `camera-detection` |
| 模型 | 1 | `model-selection` |
| POC（历史 + 手册） | 2 | `poc-readme` `poc-design` |
| 契约专题 | 3 | `contract-upgrade` `interface-redesign` `timing-contract-review` |
| ADR | 7 + 1 | `decisions/0001`–`0007` + `decisions/README` |
| 索引 | 1 | `index` |

合计 **28 个文件、约 4 700 行**。最大的三篇：`software-architecture`(802 行)、`voice-architecture`(529)、`interface-redesign`(426)。

### 1.2 问题清单（按严重度）

#### P0 — 索引漂移（最该先修）

`doc/index.md` 是项目唯一的文档入口（README 指向它），但它只登记了 18 条，**漏了 4 篇正文**：

| 漏登记 | 性质 | 后果 |
| --- | --- | --- |
| `layers-and-modules.md` | 声明自己是「层口径的**唯一**事实源」 | 最权威的口径页，索引里查不到 |
| `timing-contract-review.md` | 10-18 现状核实 | 找不到 → 会被当新问题重做 |
| `contract-upgrade.md` | 10-18 契约升级方案 | 同上 |
| `interface-redesign.md` | 10-18 接口重设计 | 同上 |

另外 index 的排序**毫无规律**（按创建时间混排），且 `layers-and-modules` 这种「口径页」没有置顶。

#### P0 — 校验不达标

跑 `python3 .agent/tools/validate_wiki.py --path projects/robot/doc`：

```
ERROR（6） 全部是 relations.predicate 用了未声明的 related-to / relates-to
            可用值：about, depends-on, documented-in, part-of, uses
            位置：0003 / 0004 / 0005（related-to）、0006 / 0007（relates-to）、layers-and-modules（related-to）
WARNING（10）
  7 处 generated.by = 'assistant:workbuddy' 不合 actor 约定（应 <tool>/<model> 或 human:<id> / process:<id>）
  1 处 layers-and-modules.md:44 双链里的 \| 被转义，解析不到目标
```

根侧规则要求「error 必须清零」，当前不满足。**注意**：`assistant:workbuddy` 是我（WorkBuddy）自己写文档时留下的，
属我引入的问题，应一并修正。

#### P1 — 同主题内容散在多处

| 主题 | 散在几处 | 应该怎么收敛 |
| --- | --- | --- |
| ESP32 引脚分配 | **5 篇**（electrical §5.2、stepper-wiring §5.5、wiring-connectors、poc-design、poc-readme） | electrical §5.2 为唯一事实源，其余只链不抄 |
| 摄像头 UVC 判定 | **9 篇**提到，scripts 细节 2 处 | camera-detection 为唯一事实源 |
| 0.84s 视觉实测数字 | **5 处**（含 ADR-0001、risk-assessment、software-architecture） | 只留在 `eval/vision-latency.md`，正文链过去不复制数字 |
| 「层」的口径 | **3 处**（layers-and-modules、architecture §4.1、software-architecture §3） | layers-and-modules 为唯一口径，另两处只链 |
| 契约（线协议 / 事件 / 状态归属） | **4 篇**（communication-protocol、contract-upgrade、interface-redesign、timing-contract-review） | 需决策（见 §4） |

`AGENTS.md` 已经写了「新旧资料冲突时并存：标清来源与时间，不覆盖旧结论」——
这解释了**为什么会重复**，但没解决**读者不知道看哪份**的问题。

#### P1 — 时效分区缺失

同一个 `doc/` 目录里混着四种不同「保质期」的内容：

| 性质 | 例子 | 保质期 |
| --- | --- | --- |
| 当前设计口径 | `architecture` `software-architecture` `electrical-architecture` | 长期，改了要留 ADR |
| 运行手册 | `poc-readme` | 随代码变，需高更新 |
| 一次性核实 / 评审记录 | `timing-contract-review`（「核实时点：2026-10-18」） | **有时效，过期即误导** |
| 未来方案 / 提案 | `contract-upgrade` `interface-redesign` `voice-architecture` | 待落地，落地后应改写为「设计」 |

读者从标题看不出这一点 —— `timing-contract-review` 和 `architecture` 看起来同级。

#### P1 — 命名与内容不符

- `poc-readme.md` / `poc-design.md`：标题写「机器人 POC」，但内容已是**当前**运行手册（2026-10 起代码在 `src/`，不再是 `poc/`）。名字让人以为是一份历史记录。
- `layers-and-modules.md`：标题很好（「唯一口径」），但文件名看不出是「术语表 / 口径页」。
- `hardware-selection.md` 的 frontmatter 有 `status: draft`，实际内容已定稿（已在采购）。

#### P1 — 断链

doc 内引用了 7 个项目内不存在的目标（部分是指向仓库根知识库的，按独立性约束本就不该出现）：

```
[[macmini-robot-precedents]]   ← 仓库根知识库，2 处引用（communication-protocol、power-architecture、product-positioning）
[[esp32-s3-setup]]             ← 同上（architecture、software-architecture）
[[symphony]] [[codex-as-a-platform]] [[agent-harness]] [[codex]]  ← 同上（software-architecture、software-design）
[[poc/design]]                 ← 旧路径（decisions/README 的待回填表）
[[README|POC 使用说明]]         ← 歧义链接（poc-design 里，实际指 poc-readme）
```

按 `AGENTS.md`「不引用项目外的仓库路径」，这些应改成「外部资料（不在本项目内）+ 来源 URL」。

#### P1 — 残留旧路径

6 篇文档里出现 `work/poc/…`（camera-detection、communication-protocol、electrical-architecture、poc-design、poc-readme、voice-architecture）。
按 `AGENTS.md` 的迁移说明，那批旧产物**未迁移、仍在原处**，所以**路径是对的**，
但读者不知道 → 应加一句「（2026-10-15 前的根 `work/`，未迁移）」而不是改路径。

#### P2 — 孤儿与结构

- 入链 0 的文档：`voice-architecture.md`（**没有任何文档链向它**，只有 index 和 README 提到）。这么大的改造方案，无人引用。
- `index.md` 本身入链 0，但 README 指向它（用 `[[doc/index|...]]`），可接受。
- `decisions/README.md` 是决策日志，但待回填清单里有 8 条候选决策长期挂着（最早 2026-10-05）—— 属内容债。

## 2. 目标结构

### 2.1 决策：**保持扁平 + 绝对双链**，不目录化

理由（这是本方案最关键的一条判断）：

1. doc 内已有 **100+ 处** `[[双链]]`，且多为 `[[architecture|架构设计]]` 这种**文件名直链**；
   `src/*.ts`、`firmware/*.py` 里还有一批 `doc/xxx.md §N` 的硬路径引用。
   目录化 = 全量改链 + 改代码注释，收益（视觉分层）远小于风险（改漏 = 静默断链）。
2. 项目规则「**只依赖本目录内文件**」+ 「文档只有两个入口」（README、doc/index.md），
   说明**入口收敛**就够，不需要物理分层。
3. 28 篇的量级，扁平在 `ls` 里还能一眼看完；超过 ~40 篇再考虑子目录。

### 2.2 用「分类前缀 + hub 页」代替目录

**① 文件名前缀表意**（渐进改名，改名时同步 `grep -r` 改引用）：

| 前缀 | 含义 | 现状中该归此类的 |
| --- | --- | --- |
| `design-` | 当前设计口径（长期有效） | architecture / software-architecture / electrical-architecture / communication-protocol … |
| `setup-` | 装配 / 运行手册 | stepper-wiring、wiring-connectors、camera-detection、poc-readme |
| `note-` | 一次性核实 / 评审 / 提案（有时效） | timing-contract-review、contract-upgrade、interface-redesign |
| `hub-` | 入口索引页 | 新增 4 个 |

> ⚠️ 改名是**可选增值项**，不是必须。真正解决问题的是 ② 和 §3 的 P1。

**② 新增 4 个 hub 页**（把「读者该看哪份」写死）：

| hub 页 | 回答 | 收录 |
| --- | --- | --- |
| `index.md`（改造成分层索引） | 全部文档 | 见 §3 P1 |
| `hub-hardware.md` | 硬件 / 电气从哪看起 | electrical、power、stepper、wiring、hardware-selection、camera |
| `hub-software.md` | 软件从哪看起、四层口径 | software-architecture、software-design、layers-and-modules、communication-protocol、voice-architecture |
| `hub-contract.md` | 「契约现在以哪份为准」 | communication-protocol（当前）、contract-upgrade / interface-redesign（提案）、openapi.yaml |

**③ 统一正文里的「相关页面」写法**：当前 12 篇有该章节，格式不一（有的带序号 `## 8. 相关页面`，有的不带）。
统一为 `## 相关页面` 无序号 + 每条一句「为什么相关」。

## 3. 执行计划

### P0 · 机械修复（不改语义，可立即做）

| # | 动作 | 涉及文件 | 验收 |
| --- | --- | --- | --- |
| 0.1 | 6 处 `related-to` / `relates-to` → `about` | 0003–0007、layers-and-modules | `validate_wiki.py` error 归零 |
| 0.2 | 7 处 `generated.by: assistant:workbuddy` → `workbuddy/<model>` 形式 | contract-upgrade、0003–0007、interface-redesign、layers-and-modules、timing-contract-review | 同上 warning 减 7 |
| 0.3 | 修 `layers-and-modules.md:44` 转义双链 `\|` | 1 处 | warning 全清 |
| 0.4 | 7 个断链目标改为「外部资料（不在本项目内）」+ URL，或改指正确文件 | 见 §1.2 断链表 | 全库 `validate_wiki.py` 无 unresolved |

> P0 **不动任何正文**，只动 frontmatter 和链接。风险 ≈ 0，可一次提交。

### P1 · 索引重建（不动正文，解决「找不到 / 看错」）

| # | 动作 |
| --- | --- |
| 1.1 | 重写 `index.md`：按「**先看什么** → 总体 / 硬件 / 软件 / 契约 / 决策 / 实测」分层，每类第一行写「**唯一事实源是 X**」 |
| 1.2 | 补登 4 篇漏掉的文档（layers-and-modules、timing-contract-review、contract-upgrade、interface-redesign） |
| 1.3 | 每条索引后加**时效标注**：`（当前口径）` / `（2026-10-18 核实，有时效）` / `（提案，未落地）` |
| 1.4 | `voice-architecture` 加回链：在 architecture §4.1 或 software-architecture §3 的音频处链一次（解决孤儿） |
| 1.5 | `decisions/README` 的「待回填」表：把 8 条候选按「还做不做」标一次，不做就删行 |

### P2 · 内容归位（**需要你拍板**，见 §4）

| # | 动作 | 风险 |
| --- | --- | --- |
| 2.1 | 引脚分配：electrical §5.2 立为唯一源，stepper-wiring §5.5 / wiring-connectors / poc-* 只留一句 + 链 | 低（删重复表格） |
| 2.2 | 0.84s 数字：正文里的数字改为「见 `eval/vision-latency.md`」，不复制数值 | 低 |
| 2.3 | 契约四篇收敛成「1 当前 + 1 提案」（见决策 A） | **中**，可能删合内容 |
| 2.4 | 记录类文档加时效头（「本页结论基于 2026-10-18 的代码，之后可能失效」） | 低 |
| 2.5 | 旧路径 `work/poc/…` 加「（根 work，未迁移）」注 | 低 |

### P3 · 防回退（加门禁）

| # | 动作 |
| --- | --- |
| 3.1 | 在 `doc/index.md` 顶部写「**新增文档必须登记进本页**」 |
| 3.2 | 提交前跑 `python3 .agent/tools/validate_wiki.py --path projects/robot/doc`，error 必须为 0 |
| 3.3 | 建议加进 `package.json`：`"docs:check": "python3 ../.agent/tools/validate_wiki.py --path doc"`（可选） |

## 4. 需要你拍板的三件事

**A. 契约主题怎么收敛？**（`communication-protocol` / `contract-upgrade` / `interface-redesign` / `timing-contract-review` 互相大量交叉）

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| A1（推荐） | 三篇记录类**保持独立**，只加时效头 + 在 `hub-contract.md` 写清「谁先谁后、现在以哪份为准」 | 最小，但内容仍分散 |
| A2 | `contract-upgrade` + `interface-redesign` 合成一篇 `design-contract-v2.md` | 结构最干净，但要重写合并，且两篇是不同时点的结论 |
| A3 | 全部并进 `communication-protocol.md` | 那篇会膨胀到 1000+ 行，不建议 |

**B. 记录类文档要不要进子目录？**（如 `doc/notes/`）
- 好处：物理上把「有时效」和「长期设计」分开，`ls` 一眼可辨。
- 代价：要改链（`timing-contract-review` 入链 1、`contract-upgrade` 1、`interface-redesign` 1），**代价其实很小**。
- 我的看法：**先不做**。先靠 index 的时效标注解决；若 P2 做完还乱，再迁（那时入链也已被收敛）。

**C. `voice-architecture.md` 怎么定位？**
它现在标题是「改造方案（流式优先）」，但 §13 已写「实现记录（2026-10-13：听/说的流式已落地）」——
**方案已落地了**。要么改写成 `design-voice.md`（当前语音子系统设计），要么保留为「改造记录」并在 software-architecture 里另立一节写当前口径。前者更省事。

## 5. 建议的提交切分

```
chore(docs): 修 frontmatter 谓词与 actor 格式，校验 error 归零        ← P0
docs(docs): 重建 doc/index.md 分层索引并补登 4 篇                     ← P1
docs(docs): 收敛引脚/实测数字/契约的单一事实源                        ← P2（拍板后）
chore(docs): 加 doc 校验门禁与新增文档登记规则                        ← P3
```

四步互相独立，任何一步都可以单独叫停。

## 6. 怎么验证本方案生效

```bash
# 1. 校验必须 error=0
python3 .agent/tools/validate_wiki.py --path projects/robot/doc

# 2. 断链必须为空（输出应为 0 行）
grep -oh '\[\[[^]|]*' doc/*.md doc/decisions/*.md | sed 's/\[\[//' | sort -u   # 人工比对下节 1.2 断链表

# 3. 索引覆盖率：doc/*.md 每个文件都应在 index.md 里出现
for f in doc/*.md; do grep -q "$(basename $f)" doc/index.md || echo "漏登记: $f"; done
```

## 相关页面

- [`doc/index.md`](../index.md) —— 本方案 P1 要改造的索引页。
- [`AGENTS.md`](../../AGENTS.md) —— 文档与决策规则、ADR 骨架、独立性约束的出处。
- [`eval/README.md`](../../eval/README.md) —— 实测记录的归属地（P2.2 的落点）。

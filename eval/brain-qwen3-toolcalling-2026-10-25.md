---
title: 本地大脑全链路验证（Qwen3-4B + mlx_lm + moon-bridge + Codex）— 2026-10-25
type: project
description: 实测 Codex --Responses--> moon-bridge(:18081) --Chat--> mlx_lm(:18082) --> Qwen3-4B 的完整链路；结论为通过（Codex 能自主调用 shell 工具读文件）。同时实测：关闭 Qwen3 思考后工具调用准确率 14/14（开思考 12/14）、输出 token 降为 1/5。
tags: [project, robot, brain, mlx, moon-bridge, codex, tool-calling, eval]
domain: robot
project: macmini-robot
sources: []
generated: { by: opencode/deepseek-v4.1, at: 2026-10-25T20:25:00+08:00 }
---

# 本地大脑全链路验证

> 目的：确认「未配置高级模型」时，本地大脑能作为 Codex 的推理后端真正可用——
> 不只是能回一句话，而是能**自主发起工具调用并拿到结果**。

## 1. 链路与端口

```
Codex --Responses/SSE--> moon-bridge(:18081) --Chat Completions--> mlx_lm.server(:18082) --> Qwen3-4B-4bit
```

| 进程 | 端口 | 说明 |
| --- | --- | --- |
| `mlx_lm.server` | 127.0.0.1:18082 | 上游推理，MLX/Metal |
| `moon-bridge` | 127.0.0.1:18081 | Responses → Chat 协议转换（含 Web Console） |
| modeld（计划） | 0.0.0.0:8790 | 未来唯一对外端口，托管上面两个子进程 |

三者都只绑回环，外部不可达。

## 2. 环境

| 项 | 值 |
| --- | --- |
| mlx_lm | 0.31.3（mlx 0.32.2） |
| 模型 | `mlx-community/Qwen3-4B-4bit`，2.1 GB |
| moon-bridge | 源码编译自 `main`（GPL-3.0），Go 1.25.4 |
| Codex CLI | 0.157.1 |
| 脚本 | `work/poc/brain/`：`00_start_brain.sh` `01_test_mlx_tools.py` `02_test_moonbridge.py` `03_start_moonbridge.sh` `04_test_brain_nothink.py` |

## 3. 核心结论：关闭思考后准确率反而更高

Qwen3 默认开思考。实测「你好」一句要 312 输出 token，其中 reasoning 占 458 字符。

用 14 条用例（stop / follow / move 三类意图 + 4 条不该调用的负例）对比：

| | 开思考 | 关思考 |
| --- | --- | --- |
| 通过 | 12 / 14 | **14 / 14** |
| 输出 token 合计 | 2472 | **486** |
| reasoning 字符 | 4432 | **0** |

**开思考的 2 条失败不是「判断错」，而是输出预算被思考吃光**：`max_tokens=256` 时
`finish_reason=length`、`content` 为空、`tool_calls` 也为空——从调用方看就是「什么都没返回」。
这正是长链路里最容易被误诊为「模型不行」的失败模式。

关思考后的典型输出（`max_tokens=256`，temperature 0）：

```
'停一下！'               → robot_stop({})                                        16 tok
'跟着那个人走，保持一米'    → robot_follow({"target":"人","distance_m":1.0})        29 tok
'追踪前面的箱子，离远点，两米' → robot_follow({"target":"箱子","distance_m":2.0})      29 tok
'向后退半米'              → robot_move({"direction":"backward","distance_m":0.5})  29 tok
'今天的天气怎么样？'        → 未调用（正确）                                        53 tok
```

复现：`python3 work/poc/brain/04_test_brain_nothink.py`

## 4. 坑 1：思考只能在启动参数关，请求侧关不掉

`mlx_lm.server` 支持两种关法：

- 请求体 `chat_template_kwargs`（`server.py:1192`）
- 启动参数 `--chat-template-args`（`server.py:1850`，帮助文本明确用 `{"enable_thinking":false}` 举例）

**但 moon-bridge 不透传 `chat_template_kwargs`**：它的 `ChatRequest` 字段固定
（`internal/protocol/chat/types.go`），只下发 `reasoning_effort`，而 mlx_lm 不认该字段。
所以必须在启动 mlx_lm 时就关掉——全局生效，`00_start_brain.sh` 已内置。

## 5. 坑 2：模型 id 是绝对路径 → 上游 404

`mlx_lm.server` 把 `--model` 的原字符串直接当 id：

```json
{"id": "/Users/tq02ksu/workspace/bot/models/Qwen3-4B-4bit"}
```

请求体 `model` 必须**精确匹配**，否则 404，且错误信息**不提示是 id 不匹配**，极易误判成端点不存在。

跨进程传递时不能靠「客户端自己去 `/v1/models` 取 id」——**moon-bridge 的 `/v1/models` 不是 OpenAI 格式**：

```json
{"models":[{"slug":"qwen3-local","model":"…","provider":"local-mlx"}]}
```

（OpenAI 是 `{"data":[{"id":…}]}`。）

解决方式：在 moon-bridge 的 offer 里用 `upstream_name` 显式指定发给上游的 model 名。
这样客户端永远只见别名 `qwen3-local`，绝对路径只存在于一处配置。

## 6. 坑 3：moon-bridge 的若干行为差异

| 现象 | 影响 |
| --- | --- |
| `/v1/models` 返回 `{"models":[{"slug"}]}` 而非 `{"data":[{"id"}]}` | 客户端不能靠它自动取模型名 |
| **非流式**响应 content 类型是 `text`（规范要求 `output_text`） | 严格解析方会读不到正文 |
| **流式** content 类型正确为 `output_text` | Codex 走流式，不受影响 |
| 未知模型直接返回 **404**，日志才写「请求了未知模型」 | 排查时先看 moon-bridge 日志 |
| 未启用持久化时日志刷 ERROR（`no persistence provider registered`） | 无害，仅表示 Console 的配置保存不可用 |
| Web Console 挂在同一端口 `/console/`，无额外端口 | 符合「单端口」约束 |

## 7. Codex 端到端（通过）

配置文件由 `moonbridge -print-codex-config` 生成，落在隔离的 `CODEX_HOME`，
不动用户现有 `~/.codex`。

**纯对话**：`codex exec "1+1等于几"` → `1+1等于2。`

**工具调用闭环**：

```
codex exec "读取当前目录的 note.txt，然后告诉我里面写了什么"
  → exec /bin/zsh -c 'cat note.txt'   succeeded
  → 文件 note.txt 中的内容是：hello
```

Codex 在 `sandbox: read-only` 下自主发起 shell 工具调用，拿到结果后再作答——
证明 Responses 的 `function_call` / `function_call_output` 往返完整可用。

### 生成配置时要注意

- 生成器会**注入 `[mcp_servers.deepwiki]`**（外网 MCP），本地大脑用不到，已删除。
- `model_max_output_tokens` 在 Codex 0.157.1 里**已废弃**，会打印 unrecognized 警告，已删除；
  改由 catalog 里的 `max_output_tokens` 承载（生成器给的是 `null`，建议手工补 4096）。
- `models_catalog.json` 的 `context_window=32768` 来自配置的 `models.qwen3-local.context_window`。

## 8. moon-bridge 的获取方式（无预编译二进制）

Releases 为空、无 brew 包，只能编译一次；但**不需要系统装 Go**：

```bash
# Go 官方 CDN 实测 32 MB/s（Homebrew bottle 只有 38 KB/s，慢 200 倍）
curl -L -o go.tar.gz https://dl.google.com/go/go1.25.4.darwin-arm64.tar.gz
tar xzf go.tar.gz -C work/poc/brain/bin     # 自带 go 放 bin/go，不碰系统目录
```

编译产物 `bin/moonbridge` 是静态二进制，之后**完全不需要 Go**。

网络坑位（本机实测）：GitHub 直连不通、`codeload` 中途截断；
`api.github.com/.../zipball/main` 可用；Go 模块走 `goproxy.cn`。

## 9. 复现

```bash
cd projects/robot
sh work/poc/brain/00_start_brain.sh --bg          # mlx_lm :18082，已关思考
sh work/poc/brain/03_start_moonbridge.sh          # moon-bridge :18081

python3 work/poc/brain/01_test_mlx_tools.py       # 地基：结构化 tool_calls
python3 work/poc/brain/04_test_brain_nothink.py   # 14 条意图用例
python3 work/poc/brain/02_test_moonbridge.py      # Responses 转换 + SSE

# Codex 端到端
export CODEX_HOME="$PWD/work/poc/brain/codex-home"
cd "$CODEX_HOME/ws" && codex exec --skip-git-repo-check "读取 note.txt 并告诉我内容"
```

## 10. 尚未验证 / 待办

- **modeld 尚未接入**：当前是三个进程手工起；`src/modeld.py` 仍是 stub。
  需改成托管两个子进程 + 反代 + 单端口 8790。
- **并发**：只测了单请求串行。4B 模型在 24 GB 上并发表现未测。
- **长上下文**：32K 上限下多轮工具调用的稳定性未测（Codex 首轮系统提示约 17K token）。
- **视觉**：本链路纯文本；视觉仍由 `mlx_vlm.server`(:18080) 承担，二者未打通。
- **moon-bridge 非流式 `output_text` 偏差**：未向上游提 issue，本地未打补丁。

## 相关

- 选型：`doc/model-selection.md` §5
- 方案审查过程（临时产物）：`work/poc/brain/review-notes.md`

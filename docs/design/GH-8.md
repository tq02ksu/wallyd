# GH-8：快速路由规则表的长大方式

状态：已实现（`agentd/src/agentd/router.ts` + 单测 + 契约漂移断言）。对应 issue #8。

## 问题

`FAST_RULES` 只有一条规则，否定守卫又是**整串包含**匹配：

- 任何含「能不能」「可以吗」的句子都被挡回 Harness，「能不能往前走一点」这种最常用的请求也慢；
- 规则只能整串正则 + 可选的 `args(m)` 逃生口，加一条「跟着我走」要手写一堆正则，
  也没法统一校验「缺参数」；
- 规则里的 `capability` 是对端工具名，规则表与 `contracts/generated/mcp-tools.json`
  漂移了要等运行时 `resolve()` 才发现。

## 决策 1：否定按作用域判断，受保护规则不受放宽

新增 `FastRule.negationScope: 'adjacent' | 'sentence'`，默认 `adjacent`。
`matchRoute` 用 `rule.patterns` 的**命中位置**切片出动词前缀，再判两件事：

1. **前缀必须是合法引导语**（`LEAD_IN`）：句首、`，`/`、`/`。`/`；` 后的新分句，
   或少量礼貌/语气词（请、帮我、能不能、可以、能否、先、那就、嗯、好）。
   这挡掉「继续停止」「拿过来」「停止跟着我」这类**词中拼接**；
2. **不能紧贴否定词**（`ADJACENT_NEGATION`）：否定词后只允许 0–2 个空格/逗号。

于是：

| 输入 | 结果 | 原因 |
| --- | --- | --- |
| `别停` | 无匹配 | 否定紧贴动词 |
| `别着急，过来` | 识别 `come_here` → 澄清 | 「别」是分句语气词，不紧邻动词 |
| `拿过来` | 无匹配 | 前缀「拿」不是合法引导语（不是独立分句） |

**受保护规则恒为 `sentence`**：`scopeOf()` 对 `protected` 规则返回 `sentence`，
声明成 `adjacent` 也不会放宽。STOP 命中时整句任意否定/疑问都拦掉，
宁可多交给 Harness，也不把「别着急，停」猜成一次真实停止。

没有选「按字符距离 N 判否定」：只比距离会把「拿过来」「继续停止」的尾部也当成动词，
必须同时约束前缀是独立分句。也没有用 lookbehind：可读性差，且 `match.index` 切片足够。

### 守卫原因必须可区分（评审意见 2，本轮补）

第一版 `guarded()` 返回 boolean，把三种完全不同的原因混成一个出口：

| 原因 | 例子 | 说的是什么 | 放宽条件 |
| --- | --- | --- | --- |
| `negation` | `别停`、`别跟着我走`、`别着急，停下来` | 用户不是这个意思 | 只有在「否定词不再紧邻动词」时才该改 |
| `question` | `能不能停`（受保护规则） | 用户在问，不是在下令 | 执行它等于替用户猜 |
| `prefix` | `继续停止`、`拿过来`、`停止跟着我` | 这句话的结构没听清，动词可能只是别的词的一部分 | 放宽 `LEAD_IN` 词表时才会动 |

现在 `guarded()` 返回 `BlockedReason | null`，`matchRoute` 在 `kind: 'none'` 上带
`blocked: { rule: 'id@version', reason }[]`（一条规则都没匹配上时不带这个字段）。
这不是给用户看的文案，是给调规则的人看的判据：`none` + `blocked` 说明**规则说对了、
只是被判成否定/疑问/词中拼接**；`none` 且无 `blocked` 才说明**根本没有规则覆盖**。

顺序也有讲究：先判否定、再判前缀。`别跟着我走` 的前缀「别」不是合法引导语，
但它首先是否定——顺序反过来，拦截决策不变，原因却会骗人。

`run-request.ts` 在 `/api/run` 的决策里对这种命中记一条 `router.blocked` 日志（只有装配层注入了 logger 时才记；只记规则与原因，
不重复记原句）。**刻意不写进 run 事件或 HTTP 响应**：那要改
`agentd/contracts/openapi.yaml` 的响应形状，属于契约变更，不在本 issue 范围；
等有人真的要用它做规则命中率分析时再按「契约 → 生成物 → 测试 → 实现」走一遍。

顺带记录一条容易误读的事实：`stop_robot@1` 的 pattern 是 `^停$` / `^(停下来|…)$`，
`别停`、`不要停下来` 是被**锚点**挡住的，根本没走到守卫。守卫的作用域判断只对
尾部锚定或非锚定的表达（`follow_me` / `come_here`）有意义。单测里为此单独钉了一条断言，
防止有人以为「停」的否定保护来自守卫而把它放宽。

## 决策 2：结构化参数槽

`args?: (m) => {...}` 换成 `slots?: { name, pattern, required }[]`：

- `pattern` 恰好一个捕获组，抽到的值就是参数；
- 必填槽缺失 → `clarify`，`missing` 里带 `slot:<name>`，**绝不带空参数执行**；
- 槽名必须是目标能力 `inputSchema.properties` 里的字段名（契约测试校验）。

去掉旧的函数式 `args` 是刻意的：它没有统一的缺参语义，也没法被静态校验。
当前没有规则依赖它，不存在迁移成本。

## 决策 3：三条规则，其中两条映射同一能力

| 规则 | 版本 | 能力 | 参数 |
| --- | --- | --- | --- |
| `stop_robot` | `@1`（不动） | `robot_stop` | 无，`protected` |
| `follow_me` | `@1` | `robot_follow` | 必填 `target_track_id` |
| `come_here` | `@1` | `robot_follow` | 必填 `target_track_id` |

`stop_robot` 的规则表达与版本都保持原样：历史 run 里记的是 `stop_robot@1`，
改表达就改版本会改写历史语义。

`come_here` 也映射 `robot_follow`：当前公开运动能力只有这一个，
issue 明确不发明新 API。两条规则用不同 `id` 留痕，将来若出现独立的「靠近」能力再各自指向。

**不补「走两步」**：它没有安全上界，应交给 Harness + 审批（issue 明确不做）。

## 决策 4：目标未绑定 → 澄清（与 issue 示例表格的一处差异）

issue 表格写「`跟着我走` / `跟紧点` / `过来` → matched follow_me / come_here」。
规则识别确实一致，但本实现返回 **`clarify`**，因为规格 §3.1 写的是
「『跟我走』只有目标可靠绑定且能力已发布时才映射 `robot_follow`，否则澄清」，
`docs/architecture.md` 也要求 agentd 把「我」绑定到目标 track。

快速路由手里没有 track 证据；填一个 `target: '我'` 只是把猜测推进能力层。因此：

- `跟着我走` → `clarify(follow_me, missing: slot:target_track_id)`；
- `跟着我走 track:t7` → `matched(follow_me, args.target_track_id = 't7')`；
- `可以跟着我吗` → `clarify(follow_me)`：疑问句不会被否定守卫吞掉，也不会执行。

命中的 `fast_rule` 仍记录 `follow_me@1` / `come_here@1`，可追溯性不变。
执行层照旧从能力契约取 `approvalParams`（存在即需审批）：`robot_follow` 需要审批，
即便 `matched` 也会停在 `waiting_confirmation`，不会因为命中快速路由就动。

## 决策 5：能力漂移在 CI 就红

新增 `agentd/tests/contract/router.mjs`（接进 `npm run test:contract`）：

- 每条规则的 `capability` 必须出现在 `contracts/generated/mcp-tools.json` 的 `name` 集合（0 条例外）；
- 每个参数槽名必须是该能力 `inputSchema.properties` 的字段；
- 规则不得携带任何 `approv*` 字段（审批只从能力契约取）；
- `stop_robot` 仍存在、`protected`、映射无审批的 `robot_stop`；工具面仍是 14 项。

读生成物而不是 YAML：`npm run contract:check` 已证明生成物 == 契约源，
本测试证明「规则表 == 生成物」，两段合起来才是完整链路。

## 合入 main 后的落点（GH-27 / #28）

`#28`（GH-27）把「一句话 → run 还是澄清」的决策搬进 `agentd/src/agentd/run-request.ts`，
本 issue 的 `router.blocked` 日志因此落在那里（`submitRunRequest()` 里 `matchRoute` 之后），
logger 由 `service.ts` 用同一个 `makeLogger` 注入，不新造日志设施。

澄清不建 run 之后，「目标未绑定 → `clarify`」不再占活动名额：说过一句「过来」不会让机器人
一直忙到重启。受保护的 `stop_robot` 在忙时仍是安全旁路。这两条都不改变规则表的判据——
规则只回答「这句话是不是这个意图」，要不要执行、要不要审批由能力契约与 run 状态机决定。

 . "## 拒绝的方案"

- **NLU / 模型做意图分类**：违反 ADR-0006 与规格 §3.1 的「确定性优先」；
- **同义词表**：`停`/`停止` 靠 pattern，不靠词典；
- **热更新规则配置**：先把形状做对，再谈可配置；
- **把审批标志写进规则**：会变成第二份真值，且会绕过能力契约。

## 验证

- `agentd/tests/unit/router.test.ts`：issue 六类用例、每条规则的正例/反例/否定/歧义、
  参数槽、守卫原因（否定 / 疑问 / 前缀污染三者可区分）、受保护优先、版本与历史、
  `matchRoute` 纯函数性（含源码静态检查）；
- `agentd/tests/contract/router.mjs`：能力名与参数槽的漂移断言。

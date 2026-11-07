/**
 * 输入路由（A11）：把一句话变成「走确定性快速路径」还是「交给 Harness 理解」。
 *
 * ## 为什么需要它
 *
 * 在此之前 `service.ts` 把 `route: 'harness'` 写死，所有请求都标成「交给模型」，
 * 于是快速路由等于不存在：说「停」也要先过一遍模型。规格（`docs/spec/agentd-functional-design.md`
 * §3.1）要求的是**确定性优先**：
 *
 * - 「停止」走受保护的优先路径，不等模型；
 * - 只有**唯一匹配且前提满足**时才快速执行；
 * - 缺参 / 歧义 / 规则冲突 → 澄清，**不按「第一条命中」执行**；
 * - 无匹配 → Harness。
 *
 * ## 纪律
 *
 * 1. **不用模型判断「是否明确」**。判断依据是规则与当前证据，不是置信度分数。
 *    （这是规格原话；也让快速路由在模型离线时仍然可用。）
 * 2. **审批要求只从能力契约取**（`CapabilityInfo.approvalParams` 存在即需审批），规则不能降低它。
 *    规则里**不写**审批标志——写进规则就变成了第二份真值。
 * 3. **参数来自明确的表达**，不从自由文本里猜。规则匹配「动词短语 + 可选参数槽」，
 *    不做无边界子串匹配；参数只从 `slots` 的捕获组取，缺必填槽就澄清。
 * 4. **否定按作用域判断**：`别` / `不要` 只有在**紧邻动词**时才算否定
 *    （`别停`、`先别动`），句首/句中的语气词不算（`别着急，走过来`）。
 *    受保护规则（STOP）不接受这种放宽：命中时按整句判断，安全优先。
 *    拦下的原因要能分清楚（`BlockedReason`）：语义否定 ≠ 疑问 ≠ 词边界保护。
 * 5. **命中要留痕**：返回稳定的 `id@version`，写进 run 的 `fast_rule`，可追溯是哪个版本做的决定。
 *    停用规则不改写历史——历史记录的是当时命中的那条。
 * 6. **规则只能映射到已发布能力**：目标能力不在对端能力表里 → 澄清（并说明缺什么能力），
 *    不是硬着头皮执行。规则表与 `contracts/generated/mcp-tools.json` 的漂移由
 *    `tests/contract/router.mjs` 在 CI 兜底。
 *
 * ## 纯函数
 *
 * `matchRoute` 不读文件、不读时钟、不读环境变量、不发网络请求。规则表是模块内常量。
 * 这条是刻意的：路由判定必须在模型离线、磁盘故障时仍然给出同一个答案。
 * `tests/unit/router.test.ts` 里有显式断言（含对源码的静态检查）。
 */

export type Route = 'fast' | 'harness' | 'clarified';

export type MatchResult =
  /**
   * 没有可执行命中 → 交给 Harness。
   *
   * `blocked` 只解释「**本来会命中、但被守卫拦下**」的规则及原因；一条规则都没匹配上时
   * 没有这个字段。两者最终都走 Harness，但排查时必须能分开：前者说明规则说对了、
   * 只是被判成否定/疑问/词中拼接（该调规则或该问用户），后者说明根本没有规则覆盖
   * （该加规则，或该交给模型）。
   */
  | { kind: 'none'; blocked?: readonly BlockedHit[] }
  /**
   * 命中唯一规则，可以直接执行。
   *
   * **注意这里没有 `requires_approval`**：审批要求只存在于能力契约
   * （`CapabilityInfo.approvalParams`）。执行层必须自己从契约取，
   * 不要把「路由命中」当成「不用审批」——规格原话是「快速路由也经过同一权限与审批门」。
   */
  | { kind: 'matched'; rule: FastRule; args: Record<string, unknown> }
  /** 命中多条不同规则，或同一条规则命中多次 → 不执行，先问清楚 */
  | { kind: 'ambiguous'; candidates: string[] }
  /** 命中了规则，但缺参数或上下文前提不满足 */
  | { kind: 'clarify'; rule: FastRule; question: string; missing: string[] };

/** 被守卫拦下的一次命中：哪条规则（`id@version`）、因为什么。 */
export interface BlockedHit {
  rule: string;
  reason: BlockedReason;
}

/**
 * 守卫拦下一次命中的原因。三者都要拦，但**不能共用一个出口**：
 *
 * - `negation`：语义否定——否定词紧贴动词（`别停`、`不要停下来`），
 *   或受保护规则命中时整句出现否定（`别着急，停`）；
 * - `question`：疑问——目前只对受保护规则生效（`能不能停`）；执行它等于替用户猜；
 * - `prefix`：词边界保护——动词前还有别的内容（`继续停止`、`拿过来`、`停止跟着我`），
 *   说明这个动词不是从独立分句开始的，「停止」可能只是别的词的一部分。
 *
 * 前两者是「用户不是这个意思」，最后一个是「这句话的结构没听清」。
 * 将来放宽 `LEAD_IN` 词表只能动 `prefix` 的判定，不能顺手把 `negation` 一起放宽。
 */
export type BlockedReason = 'negation' | 'question' | 'prefix';

/** 判断某条规则的前提时能看到的证据。**只用已经观测到的事实**，不推测。 */
export interface RouteContext {
  /** 对端已发布的能力名（来自 robotd 能力表）；null 表示还没探测到 */
  available: ReadonlySet<string> | null;
  /** 当前是否有活动任务 */
  busy?: boolean;
  /** 当前是否在播报（用于「停」的语义区分） */
  speaking?: boolean;
}

/**
 * 否定词的作用域。
 *
 * - `adjacent`（默认）：只有紧贴动词的否定才算否定（`别停`、`不要跟着我`）；
 *   句首/句中的语气词不算（`别着急，过来`）。让「能不能往前走一点」这类常用句
 *   不再被整串守卫吞掉。
 * - `sentence`：整句任意位置出现否定/疑问词都算被否定（保守）。**受保护规则恒为此值**，
 *   声明成什么都不会被放宽——STOP 宁可多交给 Harness，也不能猜。
 */
export type NegationScope = 'adjacent' | 'sentence';

/**
 * 结构化参数槽：`matchRoute` 统一从文本抽取，缺必填 → 澄清。
 *
 * `name` 必须是目标能力 `inputSchema.properties` 里的字段名（契约测试会校验），
 * `pattern` 必须恰好有一个捕获组，抽到的就是该参数的值。
 */
export interface RuleSlot {
  name: string;
  pattern: RegExp;
  required: boolean;
}

export interface FastRule {
  /** 稳定 ID，snake_case；与版本一起构成可追溯的标识 */
  id: string;
  /** 规则版本：表达或语义变化就递增，历史记录靠它区分 */
  version: number;
  /**
   * 目标能力，用**对端公开工具名**（`contracts/generated/mcp-tools.json` 里的 `name`，
   * 例如 `robot_stop`）。注意这是下划线形式，不是契约里的 `operationId`
   * （`robot_stop` 恰好同名，但 `robot_calibration_get` 之类要对齐工具名而不是路径）。
   */
  capability: string;
  /**
   * 受保护的优先规则（STOP）。扩展规则**不能覆盖或延迟**它：
   * 只要有受保护规则命中，其余规则一律让路；且不受 `negationScope` 放宽。
   */
  protected?: boolean;
  /** 否定词作用域；默认 `adjacent`。受保护规则恒按 `sentence` 处理。 */
  negationScope?: NegationScope;
  /** 认可的表达。可以只锚定动词短语（尾部），由作用域与前缀规则约束。 */
  patterns: RegExp[];
  /** 操作说明，用于事件摘要与界面展示 */
  summary: string;
  /** 结构化参数槽：统一抽参，缺必填 → 澄清 */
  slots?: readonly RuleSlot[];
  /** 缺必填参数时问用户的话；省略时按 summary 与缺失参数生成 */
  clarify?: string;
  /** 可选的前提检查：返回 null 表示满足，否则返回缺失原因 */
  precondition?: (ctx: RouteContext) => string | null;
}

/** 匹配前做的归一化：全角转半角、去首尾空白、去句末标点。**不做同义词替换**。 */
export function normalizeInput(text: string): string {
  let s = text.normalize('NFKC').trim();
  // 句末标点：ASR 常带「。」「？」「！」，不影响语义
  s = s.replace(/[。．.！!？?，,、\s]+$/u, '');
  // 开头语气词：**只在后面还有内容时才剥**。
  // 「嗯，停」→「停」；但「你好」本身就是一句完整表达，剥成空串会把指令吃掉。
  s = s.replace(/^(那个|嗯|呃|你好|嘿)[，,\s]+/u, '');
  return s.trim();
}

/** 否定词（不区分作用域）。 */
const NEGATION = /(?:不要|不用|别|甭|无需|不必|勿)/u;
/** 疑问词：只对受保护规则生效，避免「能不能停」被执行。 */
const QUESTION = /(?:能不能|可不可以|可以吗|是不是|要不要|能否|吗|嘛)/u;
/** 紧邻动词的否定：否定词后最多跟空格/逗号，再就是动词。 */
const ADJACENT_NEGATION = /(?:不要|不用|别|甭|无需|不必|勿)[\s，,]{0,2}$/u;
/**
 * 动词前允许的短引导语：句首、逗号后的分句，或少量礼貌/语气词。
 * 除此之外的前缀（`继续停止`、`拿过来`、`停止跟着我`）视为前缀污染，不算命中。
 */
const LEAD_IN = /(?:^|[，,、。；;]\s*|(?:请|帮我|能不能|可不可以|可以|能否|能|先|那就|嗯|好|你|您|快|赶紧|马上)\s*)$/u;

/**
 * 规则表。
 *
 * 只放**高确定性**的少量指令；场景需求明确后按 §3.1「增量扩展」补，
 * 每条新增都要过正例 / 反例 / 否定 / 歧义测试。
 *
 * 版本纪律：`stop_robot` 保持 `@1` 不动——已经写进 run 历史的是 `stop_robot@1`，
 * 改版本号会让历史记录指向另一套语义。新增规则各自从 `@1` 开始。
 */
export const FAST_RULES: readonly FastRule[] = [
  {
    // 停止是安全旁路：不等模型、不排队、不受「忙」限制。
    // 这里用 `^停` 而不是精确匹配，是因为 ASR 常带尾巴（「停下来」「停止」「停一下」）；
    // 但**必须**排除「不要停」「别停」这类否定 —— 受保护规则按整句判断（sentence）。
    id: 'stop_robot',
    version: 1,
    capability: 'robot_stop',
    protected: true,
    negationScope: 'sentence',
    summary: '停止机器人',
    patterns: [/^(停下来|停止|快停|停一下|立即停止|紧急停止)$/u, /^停$/u],
  },
  {
    // 「跟着我走」/「跟紧点」→ robot_follow。目标必须可靠绑定（`target_track_id`），
    // 绑不上就澄清，绝不拿「我」去猜一条 track（规格 §3.1）。
    id: 'follow_me',
    version: 1,
    capability: 'robot_follow',
    negationScope: 'adjacent',
    summary: '跟随我',
    patterns: [
      /(?:跟着我走|跟我走|跟紧点|跟紧我|跟上我|跟着我|跟我来)(?:吗|嘛|么|吧|啊|呀)?(?:[，,、\s]*(?:target_track_id|track|目标)\s*[:：=]\s*[A-Za-z0-9_-]{1,64})?$/u,
    ],
    slots: [
      {
        name: 'target_track_id',
        pattern: /(?:target_track_id|track|目标)\s*[:：=]\s*([A-Za-z0-9_-]{1,64})/u,
        required: true,
      },
    ],
    clarify: '要跟着你走，得先锁定要跟的人（目标 track）。现在还没绑定目标，先别动——告诉我跟哪条目标。',
  },
  {
    // 「过来」→ 同一语义能力 robot_follow（当前公开面只有这一个运动能力）。
    // 同样是「先绑定目标再执行」；未绑定 → 澄清。
    id: 'come_here',
    version: 1,
    capability: 'robot_follow',
    negationScope: 'adjacent',
    summary: '走到我这儿来',
    patterns: [
      /(?:过来|过来一下|到我这儿来|到我这来|来我这儿|走近点|靠近我|靠过来)(?:吗|嘛|么|吧|啊|呀)?(?:[，,、\s]*(?:target_track_id|track|目标)\s*[:：=]\s*[A-Za-z0-9_-]{1,64})?$/u,
    ],
    slots: [
      {
        name: 'target_track_id',
        pattern: /(?:target_track_id|track|目标)\s*[:：=]\s*([A-Za-z0-9_-]{1,64})/u,
        required: true,
      },
    ],
    clarify: '要过来，得先确认走到谁那儿（目标 track）。现在还没绑定目标，先说清楚找谁。',
  },
];

type Hit = { rule: FastRule; m: RegExpMatchArray };

/** 受保护规则不接受作用域放宽。 */
function scopeOf(rule: FastRule): NegationScope {
  if (rule.protected) return 'sentence';
  return rule.negationScope ?? 'adjacent';
}

/**
 * 守卫：这条命中该被拦下吗？被拦时返回**原因**，放行返回 `null`。
 *
 * - `sentence`：整句有否定 → `negation`；整句有疑问 → `question`。
 * - `adjacent`：动词前必须是合法引导语（否则 `prefix`），且不能紧贴否定词（`negation`）。
 *
 * 返回值必须是原因而不是 boolean：`negation` 是「用户不是这个意思」，
 * `prefix` 是「词边界保护」，两者的放宽条件不同（见 `BlockedReason`）。
 */
function guarded(rule: FastRule, text: string, m: RegExpMatchArray): BlockedReason | null {
  if (scopeOf(rule) === 'sentence') {
    if (NEGATION.test(text)) return 'negation';
    if (QUESTION.test(text)) return 'question';
    return null;
  }
  const prefix = text.slice(0, m.index ?? 0);
  // 先判否定、再判前缀：`别跟着我走` 的前缀「别」不是合法引导语，但它首先是**否定**。
  // 顺序反过来会把语义否定报成词边界问题（拦不拦都一样，但原因会骗人）。
  if (ADJACENT_NEGATION.test(prefix)) return 'negation';
  if (!LEAD_IN.test(prefix)) return 'prefix';
  return null;
}

/**
 * 匹配规则。
 *
 * 顺序纪律：
 * 1. 逐条求命中，并各自过否定/疑问守卫（作用域由规则声明，受保护规则恒为整句）；
 * 2. 受保护规则（STOP）单独一轮：命中即决，不让扩展规则延迟它；
 *    被否定的受保护命中一律 `none`——不把「停」的意图转给别的规则；
 * 3. 其余规则求候选集：0 条 → none；1 条 → 查参数与前提；≥2 条 → ambiguous。
 */
export function matchRoute(rawText: string, ctx: RouteContext, rules: readonly FastRule[] = FAST_RULES): MatchResult {
  const text = normalizeInput(rawText);
  if (text.length === 0) return { kind: 'none' };

  const hits: Hit[] = [];
  const blocked: { rule: FastRule; reason: BlockedReason }[] = [];
  for (const rule of rules) {
    for (const p of rule.patterns) {
      const m = text.match(p);
      if (!m) continue;
      const reason = guarded(rule, text, m);
      if (reason === null) hits.push({ rule, m });
      else blocked.push({ rule, reason });
      break; // 一条规则只认第一个命中的表达
    }
  }

  // 全都没命中时不带 `blocked`；被守卫拦下的把原因带上，便于区分「没有规则」与「规则被拦」。
  const none = (): MatchResult =>
    blocked.length === 0
      ? { kind: 'none' }
      : { kind: 'none', blocked: blocked.map((b) => ({ rule: ruleTag(b.rule), reason: b.reason })) };

  // ---- 2. 受保护规则优先
  const protectedOk = hits.filter((h) => h.rule.protected);
  if (blocked.some((h) => h.rule.protected)) return none();
  if (protectedOk.length > 1) {
    // 两条受保护规则同时命中 → 不能猜，先问
    return { kind: 'ambiguous', candidates: protectedOk.map((h) => ruleTag(h.rule)) };
  }
  if (protectedOk.length === 1) {
    return resolve(protectedOk[0].rule, ctx, text);
  }

  // ---- 3. 其余规则
  const rest = hits.filter((h) => !h.rule.protected);
  if (rest.length === 0) return none();
  if (rest.length > 1) {
    return { kind: 'ambiguous', candidates: rest.map((h) => ruleTag(h.rule)) };
  }
  return resolve(rest[0].rule, ctx, text);
}

function resolve(rule: FastRule, ctx: RouteContext, text: string): MatchResult {
  // 目标能力必须已发布：规则映射到不存在的能力 → 澄清并说明缺什么
  if (ctx.available && !ctx.available.has(rule.capability)) {
    return {
      kind: 'clarify',
      rule,
      question: `这台机器人现在没有「${rule.summary}」这个能力，不会假装执行。`,
      missing: [`capability:${rule.capability}`],
    };
  }

  // 参数只从显式槽位取；缺必填 → 澄清，不带着空参数执行
  const args: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const slot of rule.slots ?? []) {
    const value = text.match(slot.pattern)?.[1];
    if (value === undefined || value === '') {
      if (slot.required) missing.push(`slot:${slot.name}`);
      continue;
    }
    args[slot.name] = value;
  }
  if (missing.length > 0) {
    const names = missing.map((s) => s.slice('slot:'.length)).join('、');
    return {
      kind: 'clarify',
      rule,
      question: rule.clarify ?? `要${rule.summary}，还缺参数：${names}。`,
      missing,
    };
  }

  if (rule.precondition) {
    const why = rule.precondition(ctx);
    if (why !== null) {
      return { kind: 'clarify', rule, question: why, missing: ['precondition'] };
    }
  }
  // 审批要求由执行层从能力契约取（见 MatchResult.matched 的注释），这里只负责「能不能路由」
  return { kind: 'matched', rule, args };
}

/** 规则的可追溯标识：`id@version`。 */
export function ruleTag(rule: FastRule): string {
  return `${rule.id}@${rule.version}`;
}

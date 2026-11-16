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

/**
 * 同一「人机回合」内上一轮 run 的结论摘要（GH-12）。
 *
 * 只有能力名与**已经从用户话里抽取出来的参数**，没有模型正文、没有原始录音。
 * 它只用于**消歧性规则**（如「慢一点」修饰上一轮的跟随），不是会话记忆：
 * 进程重启即空，也不会写进事件库。
 */
export interface PreviousRun {
  capability: string;
  args: Readonly<Record<string, unknown>>;
}

/** 判断某条规则的前提时能看到的证据。**只用已经观测到的事实**，不推测。 */
export interface RouteContext {
  /** 对端已发布的能力名（来自 robotd 能力表）；null 表示还没探测到 */
  available: ReadonlySet<string> | null;
  /** 当前是否有活动任务 */
  busy?: boolean;
  /** 当前是否在播报（用于「停」的语义区分） */
  speaking?: boolean;
  /**
   * 同回合上一轮的 run 结论（GH-12）。**只有声明了 `requiresPreviousCapability`
   * 的消歧规则会读它**；没有上下文时为 null/undefined，此时那些规则根本不参与匹配，
   * 该句照常交给 Harness，而不是靠猜。
   */
  previous?: PreviousRun | null;
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
  /**
   * 捕获组 → 能力参数。省略时保持字符串（如 `target_track_id`）；
   * 返回 `undefined` 表示这个值不可用（例如距离越界），按「缺参」澄清，
   * 绝不把越界值硬塞给能力。
   */
  transform?: (raw: string) => unknown;
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
  /**
   * 仅当上一轮的能力等于该值时参与匹配（消歧性规则）。
   *
   * 不满足时这条规则**根本不算候选**（不是 blocked、也不澄清），
   * 因此「慢一点」在没有上文时仍然回到 Harness，判据 2 的字面口径不变。
   */
  requiresPreviousCapability?: string;
  /**
   * 从上下文派生参数。返回 null 表示上下文不足以承载这条规则
   * （例如上一轮没有可沿用的目标）——同样按「没有命中」处理，不拿空参数执行。
   */
  contextArgs?: (ctx: RouteContext) => Record<string, unknown> | null;
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
 * `robot_follow.max_speed_mps` 的契约默认值与安全边界（GH-12 的 slow_down 用）。
 *
 * 这三个数不是规则自己的判断，而是契约里的真值；`tests/contract/router.mjs`
 * 断言它们与 `contracts/generated/mcp-tools.json` 完全一致，漂移即红。
 */
export const DEFAULT_FOLLOW_SPEED_MPS = 0.15;
export const MIN_FOLLOW_SPEED_MPS = 0.05;
export const MAX_FOLLOW_SPEED_MPS = 0.4;
/** 「慢一点」把速度上限乘到的比例。 */
export const SLOW_DOWN_RATIO = 0.5;

/**
 * `robot_move.distance_mm` / `speed_mm_s` 的契约默认值与安全边界（GH-74）。
 * `tests/contract/router.mjs` 断言它们与 `contracts/generated/mcp-tools.json` 完全一致。
 */
export const MIN_MOVE_MM = 1;
export const MAX_MOVE_MM = 5000;
export const DEFAULT_MOVE_SPEED_MM_S = 150;

/** 口述距离的单位 → 毫米。只认明确单位，避免「往前走 30」被猜成 30 毫米或 30 米。 */
const MOVE_UNIT_MM: Readonly<Record<string, number>> = {
  毫米: 1,
  mm: 1,
  厘米: 10,
  cm: 10,
  分米: 100,
  米: 1000,
  m: 1000,
};

/** 「30 厘米 / 1 米 / 50mm」→ 毫米；越界或无法解析返回 `undefined`。 */
export function parseDistanceMm(raw: string): number | undefined {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*(毫米|厘米|分米|米|mm|cm|m)$/u.exec(raw.trim());
  if (!m) return undefined;
  const factor = MOVE_UNIT_MM[m[2]];
  if (factor === undefined) return undefined;
  const mm = Number(m[1]) * factor;
  if (!Number.isFinite(mm) || mm < MIN_MOVE_MM || mm > MAX_MOVE_MM) return undefined;
  return Math.round(mm);
}

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
    // GH-74：「往前走 30 厘米」必须命中能力并下发，而不是交给 Harness。
    // 只说「往前走」不入此规则：没有距离就没有可确认的参数，交 Harness 理解意图。
    // 距离越界（>5m）同样不执行：transform 返回 undefined → 澄清。
    id: 'move_forward',
    version: 1,
    capability: 'robot_move',
    negationScope: 'adjacent',
    summary: '向前直行一段距离',
    patterns: [
      /^(?:请|帮我)?(?:往前走|向前走|往前移动|向前移动|往前挪|向前挪|直走|前进)(?:大约|差不多)?\s*[0-9]+(?:\.[0-9]+)?\s*(?:毫米|厘米|分米|米|mm|cm|m)(?:吧|啊|呀)?$/u,
    ],
    slots: [
      {
        name: 'distance_mm',
        pattern: /([0-9]+(?:\.[0-9]+)?\s*(?:毫米|厘米|分米|米|mm|cm|m))/u,
        required: true,
        transform: (raw) => parseDistanceMm(raw),
      },
    ],
    // 用户只说了距离；速度用契约默认值，并显式下发，避免「默认值」变成第二份真值。
    contextArgs: () => ({ speed_mm_s: DEFAULT_MOVE_SPEED_MM_S }),
    clarify: '要往前走，请说清距离（1 到 5000 毫米之间，例如「往前走 30 厘米」）。',
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
  {
    // 「慢一点」不是一条独立指令，而是**修饰上一轮的动作**（GH-12）。
    //
    // 它只在上一轮确实是 `robot_follow` 时参与匹配；没有上文时这条规则根本不出现，
    // 句子照常交给 Harness——判据 2「过期后不猜」靠的就是这一点。
    //
    // 参数落点必须是已发布能力：`robot_follow` 的 `max_speed_mps` 是当前唯一的速度
    // 控制参数（发起跟随时指定）。因此这里沿用上一轮的目标，并把速度上限按比例降下来；
    // 不新增「改正在进行的跟随速度」这种能力面上不存在的端点。
    id: 'slow_down',
    version: 1,
    capability: 'robot_follow',
    negationScope: 'adjacent',
    summary: '把跟随速度降下来',
    patterns: [
      /^(?:再|稍微)?慢(?:一)?点(?:儿)?(?:走)?$/u,
      /^(?:再|稍微)?慢(?:一)?些(?:走)?$/u,
      /^(?:走|跟)(?:得|的)?慢(?:一)?点(?:儿)?$/u,
      /^(?:放慢|减速)(?:速度)?(?:一点|一点儿|一些|些)?$/u,
      /^(?:别|不要)(?:走|跟)(?:得|的)?太快(?:了)?$/u,
      /^别太快(?:了)?$/u,
    ],
    requiresPreviousCapability: 'robot_follow',
    contextArgs: (ctx) => {
      const previous = ctx.previous;
      if (!previous) return null;
      const target = previous.args.target_track_id;
      // 没有可沿用的目标就不猜：交给 Harness，而不是拿空 target 去执行。
      if (typeof target !== 'string' || target.length === 0) return null;
      const explicit = previous.args.max_speed_mps;
      const base =
        typeof explicit === 'number' && Number.isFinite(explicit) ? explicit : DEFAULT_FOLLOW_SPEED_MPS;
      const next = Math.min(
        MAX_FOLLOW_SPEED_MPS,
        Math.max(MIN_FOLLOW_SPEED_MPS, base * SLOW_DOWN_RATIO),
      );
      return { target_track_id: target, max_speed_mps: Math.round(next * 1000) / 1000 };
    },
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
    // 消歧性规则只在「上一轮确实是它修饰的动作」时才是候选。
    // 这里直接跳过，而不是拦成 blocked：没有上文时这句话根本没有被规则覆盖，
    // 应该诚实地落到 Harness（判据 2）。
    if (rule.requiresPreviousCapability && ctx.previous?.capability !== rule.requiresPreviousCapability) {
      continue;
    }
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

/**
 * 这句话是否命中受保护规则（当前只有 STOP）。
 *
 * 语音分发器用它把「停止」从忙判定里放行：停止是安全旁路，语音不能比
 * `POST /api/run` 更弱。判断复用同一张规则表，不另写一份停止词表。
 */
export function isProtectedUtterance(rawText: string): boolean {
  const matched = matchRoute(rawText, { available: null, busy: true, speaking: false }, FAST_RULES);
  return matched.kind === 'matched' && matched.rule.protected === true;
}

function resolve(rule: FastRule, ctx: RouteContext, text: string): MatchResult {
  // 上下文派生参数失败 = 这条规则承载不了这句话（例如上一轮没有目标）。
  // 按「没有命中」处理：交给 Harness，绝不带着空参数执行。
  let contextArgs: Record<string, unknown> = {};
  if (rule.contextArgs) {
    const derived = rule.contextArgs(ctx);
    if (derived === null) return { kind: 'none' };
    contextArgs = derived;
  }

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
  const args: Record<string, unknown> = { ...contextArgs };
  const missing: string[] = [];
  for (const slot of rule.slots ?? []) {
    const raw = text.match(slot.pattern)?.[1];
    let value: unknown = raw;
    if (raw !== undefined && slot.transform) value = slot.transform(raw);
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

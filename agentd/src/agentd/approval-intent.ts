/**
 * 语音确认的**可测谓词**：一句话是「同意」「拒绝」还是「与确认无关」。
 *
 * 边界（docs/architecture.md §10.6、issue 硬规则 3）：
 * - 否定优先：同一句里既有「确认」又有「不用」→ deny；
 * - 泛化的「好 / 好的 / 可以 / 行 / 嗯 / 对」**不能**单独批准；必须有明确的
 *   「确认」或「执行」动词。常听模式下别人随口说的「好」会变成一次 utterance，
 *   如果它就能批准，规则 6 的窗口防线形同虚设；
 * - 疑问句不批准（ASR 的「确认吗」不是确认）；
 * - 本模块**不做**窗口 / 回声判断——那是 `RunService.settleApproval()` 的事；
 *   这里只回答「这句话本身是什么意图」。
 */

export type ApprovalIntent = 'approve' | 'deny' | 'none';

export interface ApprovalIntentResult {
  intent: ApprovalIntent;
  /** 命中的词（用于日志/测试；不写进事件库正文）。 */
  matched?: string;
}

/** 明确的否定词。**先判否定，再判肯定**——「确认不用」必须按 deny。 */
const DENY_TOKENS: readonly string[] = [
  '不用',
  '不要',
  '取消',
  '算了',
  '不行',
  '不必',
  '拒绝',
  '不确认',
  '不执行',
  '不想',
];

/** 明确肯定：只有动词本身算数。 */
const APPROVE_PATTERN = /确认|执行/u;

/**
 * 「停」在确认窗口内是**拒绝**，不是新指令。
 *
 * 分发器把窗口期的 final 一律交给 settle（审批回答不能再建 run），所以这里必须认识
 * 停止词；否则用户说「停」会被当成 unrecognized 吞掉。审批尚未通过，没有任何动作
 * 在路上，拒绝就是安全的收尾。锚定整句，避免「别停」被误判成停止。
 */
const STOP_DENY_PATTERN = /^(停|停止|停下来|停一下|快停|立即停止|紧急停止)$/u;

/** 疑问/不确定：不批准。 */
const QUESTION_PATTERN = /吗|嘛|[\?？]/u;

/** 归一化：NFKC、去掉空白与句末标点。**不做同义词替换**。 */
export function normalizeApprovalText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[。．.！!？?，,、；;：:]+$/gu, '')
    .trim();
}

export function classifyApprovalUtterance(raw: string): ApprovalIntentResult {
  const text = normalizeApprovalText(raw);
  if (!text) return { intent: 'none' };

  // 1. 否定优先。`别确认` / `别执行` 也是否定，但单独的「别」不算——
  //    「特别确认」里的「别」不是否定词。
  for (const token of DENY_TOKENS) {
    if (text.includes(token)) return { intent: 'deny', matched: token };
  }
  if (/别(?:确认|执行|动)/u.test(text)) return { intent: 'deny', matched: '别…' };
  if (STOP_DENY_PATTERN.test(text)) return { intent: 'deny', matched: '停' };

  // 2. 疑问句不批准（否定已在上面处理）。
  if (QUESTION_PATTERN.test(text)) return { intent: 'none' };

  // 3. 明确肯定。
  const affirmative = APPROVE_PATTERN.exec(text);
  if (affirmative) return { intent: 'approve', matched: affirmative[0] };

  return { intent: 'none' };
}

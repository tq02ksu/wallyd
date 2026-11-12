/**
 * 快速路由的纪律测试。
 *
 * 重点不是「能匹配上」，而是**不能匹配错**：一条错误的快速路由会产生一次真实动作。
 * 所以反例（否定、疑问、前缀污染）比正例更重要。
 *
 * 这一版对应 GH-8：
 * - 否定守卫从「整串包含」改为**按作用域**判断（`negationScope`，默认 `adjacent`）；
 *   受保护规则恒为 `sentence`，不被作用域放宽。
 * - 规则用结构化参数槽 `slots` 抽参，缺必填槽 → 澄清，不带着空参数执行。
 * - 规则表中的能力名与 `contracts/generated/mcp-tools.json` 的漂移由契约测试兜底
 *   （`tests/contract/router.mjs`），本文件只测行为。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchRoute, normalizeInput, ruleTag, FAST_RULES } from '../../src/agentd/router.ts';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
}

const ANY: ReadonlySet<string> = new Set(['robot_stop', 'robot_speak', 'robot_follow']);
const ctx = { available: ANY };

const ruleById = (id: string) => FAST_RULES.find((r) => r.id === id) as (typeof FAST_RULES)[number];
const matched = (r: any, id: string) => r.kind === 'matched' && r.rule.id === id;
const clarified = (r: any, id: string) => r.kind === 'clarify' && r.rule.id === id;
const show = (r: any) => JSON.stringify(r, (_k, v) => (v instanceof RegExp ? String(v) : v));

console.log('— 归一化');
check('全角转半角 + 去句末标点', normalizeInput('  停止。 ') === '停止', normalizeInput('  停止。 '));
check('去开头语气词', normalizeInput('嗯，停') === '停', normalizeInput('嗯，停'));

// ---------------------------------------------------------------- 问题表格（GH-8）
// 这六类是 issue 正文的验收用例，逐条钉死。
console.log('— 问题表格：六类用例');
{
  const r = matchRoute('停下来', ctx);
  check('「停下来」→ stop_robot', matched(r, 'stop_robot'), show(r));
}
{
  const r = matchRoute('别停', ctx);
  check('「别停」→ 不执行（交 Harness）', r.kind === 'none', show(r));
  const r2 = matchRoute('不要停下来', ctx);
  check('「不要停下来」→ 不执行', r2.kind === 'none', show(r2));
}
{
  const r = matchRoute('别着急，往前走', ctx);
  check('「别着急，往前走」→ 不再被否定守卫吞掉（无规则 → Harness）', r.kind === 'none', show(r));
  // 证明「none」来自没有规则，而不是守卫：同句给一条能匹配的规则，必须命中。
  const advance = {
    id: 'advance',
    version: 1,
    capability: 'robot_follow',
    summary: '前进',
    patterns: [/往前走$/u],
  };
  const scoped = matchRoute('别着急，往前走', ctx, [advance]);
  check('句首的「别」不再把整句挡掉', matched(scoped, 'advance'), show(scoped));
}
{
  const r = matchRoute('能不能停一下', ctx);
  check('「能不能停一下」→ 不执行（疑问，交 Harness）', r.kind === 'none', show(r));
  const advance = { id: 'advance2', version: 1, capability: 'robot_follow', summary: '前进', patterns: [/往前走一点$/u] };
  const scoped = matchRoute('能不能往前走一点', ctx, [advance]);
  check('疑问词不再无条件挡掉整句', matched(scoped, 'advance2'), show(scoped));
}
{
  const r = matchRoute('可以跟着我吗', ctx);
  check('「可以跟着我吗」→ follow_me 澄清（不是被守卫吞掉）', clarified(r, 'follow_me'), show(r));
}
{
  check('「跟着我走」→ 识别为 follow_me', matched(matchRoute('跟着我走 track:t7', ctx), 'follow_me'));
  check('「跟紧点」→ 识别为 follow_me', clarified(matchRoute('跟紧点', ctx), 'follow_me'));
  check('「过来」→ 识别为 come_here', clarified(matchRoute('过来', ctx), 'come_here'));
}

// ---------------------------------------------------------------- stop_robot：正 / 反 / 否定 / 歧义
console.log('— stop_robot：正例');
for (const s of ['停', '停止', '停下来', '快停', '立即停止', '紧急停止', '停一下', '  停止。', '停止！']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ fast`, matched(r, 'stop_robot'), show(r));
}

console.log('— stop_robot：反例（这些绝不能触发真实停止）');
for (const s of [
  '不要停',
  '别停',
  '先别停',
  '停止了吗',
  '能不能停',
  '可以停吗',
  '不用停',
  '无需停止',
  '待会儿再停吧', // 带未知尾巴 → 不是明确指令
  '停止跟随', // 是「停止跟随」还是「停止」+「跟随」？歧义，交给 Harness
  '继续停止', // 前缀污染
]) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ 不执行`, r.kind !== 'matched', `实际 ${r.kind}`);
}

console.log('— stop_robot：否定作用域（受保护规则不被削弱）');
{
  const tailStop = { id: 'tail_stop', version: 1, capability: 'robot_stop', protected: true, summary: '停', patterns: [/停$/u] };
  const guarded = matchRoute('别着急，停', ctx, [tailStop]);
  check('受保护规则：句中任意否定都不放宽', guarded.kind === 'none', show(guarded));
  const loose = { ...tailStop, id: 'tail_stop_open', protected: false };
  const scoped = matchRoute('别着急，停', ctx, [loose]);
  check('非受保护规则：不紧邻动词的「别」不算否定', matched(scoped, 'tail_stop_open'), show(scoped));
  const adjacent = matchRoute('别停', ctx, [loose]);
  check('非受保护规则：紧邻动词的「别」仍算否定', adjacent.kind === 'none', show(adjacent));
}

console.log('— stop_robot：歧义');
{
  const twin = { ...ruleById('stop_robot'), id: 'stop_robot_twin' };
  const r = matchRoute('停', ctx, [ruleById('stop_robot'), twin]);
  check('两条受保护规则同时命中 → ambiguous', r.kind === 'ambiguous' && r.candidates.length === 2, show(r));
}

// ---------------------------------------------------------------- follow_me
console.log('— follow_me：正例（目标已绑定 → 可路由；执行层仍过审批门）');
{
  const r = matchRoute('跟着我走 track:abc123', ctx);
  check('「跟着我走 track:abc123」→ matched follow_me', matched(r, 'follow_me'), show(r));
  check('槽位抽到 target_track_id', (r as any).args?.target_track_id === 'abc123', show(r));
  check('参数里没有审批字段', !Object.keys((r as any).args ?? {}).some((k) => /approv/i.test(k)), show(r));
}
{
  const r = matchRoute('跟紧点 track:t7', ctx);
  check('「跟紧点 track:t7」→ matched follow_me', matched(r, 'follow_me'), show(r));
}
console.log('— follow_me：缺目标 → 澄清（不猜目标）');
{
  const r = matchRoute('跟着我走', ctx);
  check('「跟着我走」未绑定目标 → clarify', clarified(r, 'follow_me'), show(r));
  check('澄清说明缺 target_track_id', r.kind === 'clarify' && r.missing.includes('slot:target_track_id'), show(r));
}
console.log('— follow_me：反例');
for (const s of ['跟着音乐走', '往前走', '跟我聊聊', '停止跟着我']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ 不命中 follow_me`, !(r.kind === 'matched' && r.rule.id === 'follow_me'), show(r));
}
console.log('— follow_me：否定');
for (const s of ['别跟着我走', '不要跟着我走', '不用跟着我']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ none`, r.kind === 'none', show(r));
}
{
  const r = matchRoute('别着急，跟着我走', ctx);
  check('「别着急，跟着我走」→ 仍识别 follow_me（澄清）', clarified(r, 'follow_me'), show(r));
}
console.log('— follow_me：歧义');
{
  const follow = ruleById('follow_me');
  const twin = { ...follow, id: 'follow_me_twin' };
  const r = matchRoute('跟着我走 track:abc', ctx, [follow, twin]);
  check('两条规则同命中 → ambiguous', r.kind === 'ambiguous' && r.candidates.length === 2, show(r));
}

// ---------------------------------------------------------------- come_here
console.log('— come_here：正例');
{
  const r = matchRoute('过来 track:abc123', ctx);
  check('「过来 track:abc123」→ matched come_here', matched(r, 'come_here'), show(r));
  const plain = matchRoute('过来', ctx);
  check('「过来」未绑定目标 → clarify', clarified(plain, 'come_here'), show(plain));
  check('「你过来」→ 识别 come_here', clarified(matchRoute('你过来', ctx), 'come_here'));
  check('「快过来」→ 识别 come_here', clarified(matchRoute('快过来', ctx), 'come_here'));
}
console.log('— come_here：反例');
for (const s of ['拿过来', '过来人', '转过来']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ 不命中 come_here`, !(r.kind === 'matched' && r.rule.id === 'come_here'), show(r));
}
console.log('— come_here：否定');
for (const s of ['别过来', '不要过来', '你别过来', '别，过来']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ none`, r.kind === 'none', show(r));
}
{
  const r = matchRoute('别着急，过来', ctx);
  check('「别着急，过来」→ 仍识别 come_here（澄清）', clarified(r, 'come_here'), show(r));
}
console.log('— come_here：歧义');
{
  const come = ruleById('come_here');
  const twin = { ...come, id: 'come_here_twin' };
  const r = matchRoute('过来 track:abc', ctx, [come, twin]);
  check('两条规则同命中 → ambiguous', r.kind === 'ambiguous' && r.candidates.length === 2, show(r));
}

// ---------------------------------------------------------------- 参数槽
console.log('— 参数槽：统一抽参，缺必填 → clarify');
{
  const rules = [
    {
      id: 'slot_required',
      version: 1,
      capability: 'robot_follow',
      summary: '跟随',
      patterns: [/^跟我走(?:[\s，,]*track[:：=]?\s*[A-Za-z0-9_-]+)?$/u],
      slots: [{ name: 'target_track_id', pattern: /track[:：=]?\s*([A-Za-z0-9_-]+)/u, required: true }],
      clarify: '要先锁定目标 track。',
    },
  ];
  const no = matchRoute('跟我走', ctx, rules);
  check('必填槽缺失 → clarify', no.kind === 'clarify', show(no));
  check(
    '澄清带上原因与缺失项',
    no.kind === 'clarify' && no.question.includes('track') && no.missing.includes('slot:target_track_id'),
    show(no),
  );
  const yes = matchRoute('跟我走 track:z9', ctx, rules);
  check('槽值进入 args', yes.kind === 'matched' && (yes as any).args.target_track_id === 'z9', show(yes));
}
{
  const rules = [
    {
      id: 'slot_optional',
      version: 1,
      capability: 'robot_follow',
      summary: '跟随',
      patterns: [/^跟我走(?:[\s，,]*track[:：=]?\s*[A-Za-z0-9_-]+)?$/u],
      slots: [{ name: 'target_track_id', pattern: /track[:：=]?\s*([A-Za-z0-9_-]+)/u, required: false }],
    },
  ];
  const r = matchRoute('跟我走', ctx, rules);
  check('可选槽缺失不澄清', r.kind === 'matched' && Object.keys((r as any).args).length === 0, show(r));
}

// ---------------------------------------------------------------- 其它既有纪律
// ---------------------------------------------------------------- 守卫原因
// 评审（issue #8 评论）指出：`guarded()` 曾把「语义否定」和「前缀污染」混成一个 boolean。
// 两者都必须拦，但理由不同——前者是语义，后者是词边界保护。将来放宽 `LEAD_IN`
// 词表时，若以为两者等价，就会把保护一起放宽掉。所以原因必须是可区分的返回值。
console.log('— 守卫原因：否定 / 疑问 / 前缀污染三种原因可区分');
{
  const r = matchRoute('别停', ctx) as any;
  // 「别停」是被 `^停$` 这个锚点挡住的，不是守卫——所以没有 blocked 原因。
  // 这条断言防止有人以为「停」的否定保护来自守卫，把它放宽掉。
  check('「别停」→ none，且没有 blocked（pattern 的锚点就挡住了）', r.kind === 'none' && r.blocked === undefined, show(r));
}
{
  const r = matchRoute('别跟着我走', ctx) as any;
  check('「别跟着我走」→ none 且原因是「否定」', r.kind === 'none' && r.blocked?.[0]?.reason === 'negation', show(r));
  check('原因里记下被拦的规则是 follow_me@1', r.blocked?.[0]?.rule === 'follow_me@1', show(r));
}
{
  const carry = matchRoute('拿过来', ctx) as any;
  check(
    '「拿过来」→ 前缀污染（词边界保护，不是语义否定）',
    carry.kind === 'none' && carry.blocked?.[0]?.reason === 'prefix',
    show(carry),
  );
  const cont = matchRoute('继续跟着我走', ctx) as any;
  check('「继续跟着我走」→ 前缀污染', cont.kind === 'none' && cont.blocked?.[0]?.reason === 'prefix', show(cont));
  const stopFollow = matchRoute('停止跟着我', ctx) as any;
  check('「停止跟着我」→ 前缀污染（不猜成 follow）', stopFollow.kind === 'none' && stopFollow.blocked?.[0]?.reason === 'prefix', show(stopFollow));
}
{
  const r = matchRoute('别，过来', ctx) as any;
  check('「别，过来」→ 紧邻否定（不是前缀污染）', r.kind === 'none' && r.blocked?.[0]?.reason === 'negation', show(r));
  check('原因里记的是 come_here@1', r.blocked?.[0]?.rule === 'come_here@1', show(r));
}
{
  // 疑问只对受保护规则生效（`sentence` 作用域），而当前唯一受保护规则的 pattern 是 `^停$`，
  // 「能不能停」根本到不了守卫。所以用一条尾部锚定的受保护规则来验证守卫本身。
  const tailStop = {
    id: 'tail_stop',
    version: 1,
    capability: 'robot_stop',
    protected: true,
    summary: '停',
    patterns: [/停(?:下来)?$/u],
  };
  const q = matchRoute('能不能停下来', ctx, [tailStop]) as any;
  check('受保护规则：疑问记成「疑问」，不是「否定」', q.kind === 'none' && q.blocked?.[0]?.reason === 'question', show(q));
  const n = matchRoute('别着急，停下来', ctx, [tailStop]) as any;
  check('受保护规则：句中否定记成「否定」', n.kind === 'none' && n.blocked?.[0]?.reason === 'negation', show(n));
  // 受保护规则恒为 `sentence` 作用域，只判整句否定/疑问，不做前缀检查——
  // 所以前缀污染用一条普通规则验证（`stop_robot` 的 `^停$` 锚点自己就挡住了词中拼接）。
  const looseTail = { ...tailStop, id: 'tail_open', protected: false };
  const p = matchRoute('继续停下来', ctx, [looseTail]) as any;
  check('非受保护规则：前缀污染记成「前缀」', p.kind === 'none' && p.blocked?.[0]?.reason === 'prefix', show(p));
}
{
  const r = matchRoute('你好', ctx) as any;
  check('没有任何规则命中时没有 blocked 原因', r.kind === 'none' && r.blocked === undefined, show(r));
}
{
  const known = new Set(['negation', 'question', 'prefix']);
  const samples = ['别跟着我走', '拿过来', '继续跟着我走'].map(
    (s) => (matchRoute(s, ctx) as any).blocked?.[0]?.reason,
  );
  check('原因只有三种取值', samples.every((x) => known.has(x)), samples.join(','));
}

// ---------------------------------------------------------------- 其它既有纪律
console.log('— 无匹配 → harness');
for (const s of ['帮我看看这是什么', '你好', '', '  ', '往前走两米']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ none`, r.kind === 'none', r.kind);
}

console.log('— 能力不存在 → 澄清（不假装执行）');
{
  const r = matchRoute('停止', { available: new Set(['robot_speak']) });
  check('没有 robot_stop 时澄清', r.kind === 'clarify', r.kind);
  check('澄清说明缺什么', r.kind === 'clarify' && r.missing.includes('capability:robot_stop'), show(r));
}
{
  const r = matchRoute('停止', { available: null });
  check('能力表未知时仍可路由', r.kind === 'matched', r.kind);
}

console.log('— 受保护规则优先，扩展规则不能延迟它');
{
  const rules = [
    ruleById('stop_robot'),
    {
      id: 'greet',
      version: 1,
      capability: 'robot_speak',
      summary: '打招呼',
      patterns: [/^停止$/u], // 故意与 STOP 冲突
    },
    {
      id: 'follow_greedy',
      version: 1,
      capability: 'robot_follow',
      summary: '贪心跟随',
      patterns: [/^停止$/u], // 新增的运动规则同样不能抢走 STOP
    },
  ];
  const r = matchRoute('停止', ctx, rules);
  check('冲突时 STOP 胜出（含新增运动规则）', matched(r, 'stop_robot'), show(r));
}

console.log('— 多条非受保护规则同时命中 → 歧义，不按第一条执行');
{
  const rules = [
    { id: 'a', version: 1, capability: 'robot_speak', summary: 'A', patterns: [/^你好$/u] },
    { id: 'b', version: 1, capability: 'robot_speak', summary: 'B', patterns: [/^你好$/u] },
  ];
  const r = matchRoute('你好', ctx, rules);
  check('返回 ambiguous', r.kind === 'ambiguous', r.kind);
  check('列出全部候选', r.kind === 'ambiguous' && r.candidates.length === 2, show(r));
}

console.log('— 前提不满足 → 澄清');
{
  const rules = [
    {
      id: 'go',
      version: 1,
      capability: 'robot_follow',
      summary: '跟随',
      patterns: [/^跟我走$/u],
      precondition: (c: { busy?: boolean }) => (c.busy ? '现在有任务在进行，先停下或等它结束。' : null),
    },
  ];
  const ok = matchRoute('跟我走', { ...ctx, busy: false }, rules);
  check('前提满足 → matched', ok.kind === 'matched', ok.kind);
  const no = matchRoute('跟我走', { ...ctx, busy: true }, rules);
  check('前提不满足 → clarify', no.kind === 'clarify', no.kind);
  check('澄清给出原因', no.kind === 'clarify' && no.question.includes('任务'), show(no));
}

// ---------------------------------------------------------------- GH-12：上下文只做消歧
console.log('— GH-12：上一轮是 robot_follow 时，「慢一点」命中 slow_down');
{
  const followPrevious = { capability: 'robot_follow', args: { target_track_id: 'abc' } };
  const withPrev = matchRoute('慢一点', { ...ctx, previous: followPrevious });
  check('有上下文 → matched slow_down', matched(withPrev, 'slow_down'), show(withPrev));
  check(
    '命中版本是 slow_down@1',
    withPrev.kind === 'matched' && ruleTag(withPrev.rule) === 'slow_down@1',
    show(withPrev),
  );
  check(
    '目标是上一轮的目标（上下文只补参数，不另起目标）',
    withPrev.kind === 'matched' && withPrev.args.target_track_id === 'abc',
    show(withPrev),
  );
  check(
    '速度上限折半（默认 0.15 → 0.075）',
    withPrev.kind === 'matched' && withPrev.args.max_speed_mps === 0.075,
    show(withPrev),
  );

  const noPrev = matchRoute('慢一点', ctx);
  check('没有上一轮 → none（交给 Harness，不猜）', noPrev.kind === 'none', show(noPrev));
  const prevHarness = matchRoute('慢一点', { ...ctx, previous: { capability: 'harness', args: {} } });
  check('上一轮交给模型 → none', prevHarness.kind === 'none', show(prevHarness));
  const prevStop = matchRoute('慢一点', { ...ctx, previous: { capability: 'robot_stop', args: {} } });
  check('上一轮不是跟随 → none', prevStop.kind === 'none', show(prevStop));
  // 前置判断必须落在「上一轮能力」上，而不是「参数里恰好有目标」：去掉
  // requiresPreviousCapability 后本例会错误命中 slow_down（拿非跟随轮的目标去调速）。
  const prevOtherWithTarget = matchRoute('慢一点', {
    ...ctx,
    previous: { capability: 'move_forward', args: { target_track_id: 'abc' } },
  });
  check(
    '上一轮不是跟随（即使参数里有目标）→ none',
    prevOtherWithTarget.kind === 'none',
    show(prevOtherWithTarget),
  );
  const noTarget = matchRoute('慢一点', { ...ctx, previous: { capability: 'robot_follow', args: {} } });
  check('上一轮没有目标 → none（不拿空参数执行）', noTarget.kind === 'none', show(noTarget));

  const fromExplicit = matchRoute('慢一点', {
    ...ctx,
    previous: { capability: 'robot_follow', args: { target_track_id: 't9', max_speed_mps: 0.2 } },
  });
  check(
    '显式速度按比例折半',
    fromExplicit.kind === 'matched' && fromExplicit.args.max_speed_mps === 0.1,
    show(fromExplicit),
  );
  const atFloor = matchRoute('慢一点', {
    ...ctx,
    previous: { capability: 'robot_follow', args: { target_track_id: 't9', max_speed_mps: 0.05 } },
  });
  check(
    '不会低于契约下限 0.05',
    atFloor.kind === 'matched' && atFloor.args.max_speed_mps === 0.05,
    show(atFloor),
  );

  for (const s of ['慢点', '慢点儿', '再慢一点', '慢一些', '走慢一点', '放慢一点', '减速', '别太快']) {
    const r = matchRoute(s, { ...ctx, previous: followPrevious });
    check(`「${s}」→ slow_down`, matched(r, 'slow_down'), show(r));
  }
  for (const s of ['再往前一点', '往前', '快一点', '跟着我走', '停']) {
    const r = matchRoute(s, { ...ctx, previous: followPrevious });
    check(`「${s}」不被 slow_down 吃掉`, !(r.kind === 'matched' && r.rule.id === 'slow_down'), show(r));
  }

  const unavailable = matchRoute('慢一点', { available: new Set(['robot_stop']), previous: followPrevious });
  check('能力未发布 → 澄清，不硬执行', unavailable.kind === 'clarify', show(unavailable));
}

// ---------------------------------------------------------------- 版本与历史
console.log('— 可追溯标识：新增规则不改写历史');
{
  const stop = ruleById('stop_robot');
  check('stop_robot 仍是 stop_robot@1', ruleTag(stop) === 'stop_robot@1', ruleTag(stop));
  check('stop_robot 仍受保护且映射 robot_stop', stop.protected === true && stop.capability === 'robot_stop');
  check(
    '本版规则表就是 stop_robot / follow_me / come_here / slow_down 四条',
    FAST_RULES.map((r) => r.id).join(',') === 'stop_robot,follow_me,come_here,slow_down',
    FAST_RULES.map((r) => ruleTag(r)).join(','),
  );
  check('规则 id 唯一', new Set(FAST_RULES.map((r) => r.id)).size === FAST_RULES.length);
  check('版本是正整数', FAST_RULES.every((r) => Number.isInteger(r.version) && r.version >= 1));
  check(
    '规则不携带审批字段（审批只从能力契约取）',
    FAST_RULES.every((r) => !Object.keys(r).some((k) => /approv/i.test(k))),
  );
}

// ---------------------------------------------------------------- 纯函数性
console.log('— matchRoute 是纯函数（无 I/O / 时钟 / 环境变量）');
{
  const a = JSON.stringify(matchRoute('跟着我走 track:abc', Object.freeze({ available: ANY })));
  const b = JSON.stringify(matchRoute('跟着我走 track:abc', Object.freeze({ available: ANY })));
  check('同样输入两次得到同样结果', a === b, `${a} != ${b}`);
  const frozen = Object.freeze(FAST_RULES.map((r) => Object.freeze(r)));
  const c = matchRoute('停', Object.freeze({ available: ANY }), frozen as any);
  check('只读输入也能工作（不修改入参）', c.kind === 'matched');
}
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'agentd', 'router.ts'), 'utf8');
  check('router.ts 不 import 任何模块（没有 I/O 入口）', !/^\s*import\s/m.test(src));
  check('router.ts 不读环境变量', !/process\.env/u.test(src));
  check('router.ts 不读时钟', !/Date\.now|new Date\(/u.test(src));
  check('router.ts 不用随机数', !/Math\.random/u.test(src));
  check('router.ts 不发网络请求', !/\bfetch\s*\(/u.test(src));
}

console.log('');
if (fail > 0) {
  console.log(`${fail} 项失败`);
  process.exit(1);
}
console.log('全部通过');

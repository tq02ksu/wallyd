/**
 * 有界对话上下文（GH-12）纯逻辑测试。
 *
 * 这里只测 `ConversationContext` 本身，不碰 SQLite / HTTP：
 * - 30 秒静默边界与 8 句上限（回合边界是三元组的其中两项）；
 * - 喂给模型的提示块最多 3 轮，且必须带「仅供消歧」标记；
 * - snapshot 只含计数与 capability，绝不回放用户原话。
 */
import { ConversationContext } from '../../src/agentd/conversation.ts';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

function run(text, capability = 'robot_follow', fastRule = 'follow_me@1') {
  return { capability, fast_rule: fastRule, prompt: text };
}

console.log('— 全新上下文：第一句自己开回合');
{
  const ctx = new ConversationContext();
  const t = ctx.advance(1_000);
  check('第一句 index=1', t.index === 1, String(t.index));
  check('第一句不算接上', t.joined === false);
  check('第一句没有 reset 原因', t.reset === null, String(t.reset));
  check('没有产出时 promptBlock 为 null', ctx.promptBlock() === null);
  check('turn_id 是内存标识', typeof t.turn_id === 'string' && t.turn_id.length > 0);
}

console.log('— peek 只读、release 可回滚（评审缺陷 1 的 API 拆分）');
{
  const ctx = new ConversationContext();
  const p0 = ctx.peek(0);
  check('尚未开始时 peek 无 turn_id', p0.turn_id === null, JSON.stringify(p0));
  check('peek 不会自己开回合', ctx.snapshot().turn_id === null && ctx.snapshot().utterances === 0, JSON.stringify(ctx.snapshot()));

  const first = ctx.advance(0);
  const p1 = ctx.peek(0);
  check('同一回合内 peek 返回当前 turn_id', p1.turn_id === first.turn_id, JSON.stringify(p1));
  check('peek 不改变计数', ctx.snapshot().utterances === 1, String(ctx.snapshot().utterances));
  check('peek 报告回合未过期', p1.stale === false && p1.full === false, JSON.stringify(p1));

  const p2 = ctx.peek(30_001);
  check('超时后 peek 报 stale 且不给 turn_id', p2.stale === true && p2.turn_id === null, JSON.stringify(p2));
  check('peek 判定 stale 不开新回合', ctx.snapshot().turn_id === first.turn_id, JSON.stringify(ctx.snapshot()));

  const second = ctx.advance(1_000);
  check('advance 后计数为 2', ctx.snapshot().utterances === 2, String(ctx.snapshot().utterances));
  ctx.release(second);
  check('release 后计数回到 1', ctx.snapshot().utterances === 1, String(ctx.snapshot().utterances));
  ctx.release(second);
  check('重复 release 不会把计数扣成负数', ctx.snapshot().utterances === 1, String(ctx.snapshot().utterances));
  ctx.release({ turn_id: 'turn-other', index: 9, joined: true, reset: null });
  check('别的回合的 release 被忽略', ctx.snapshot().utterances === 1, String(ctx.snapshot().utterances));

  // 第一句就失败：状态回到「没有回合」，下一句重新开回合。
  const lone = new ConversationContext();
  const only = lone.advance(0);
  lone.release(only);
  check('第一句 release 后回到无回合', lone.snapshot().turn_id === null && lone.snapshot().utterances === 0, JSON.stringify(lone.snapshot()));
}

console.log('— 30 秒内同一回合，超时开新回合');
{
  const ctx = new ConversationContext();
  const t0 = 10_000;
  const first = ctx.advance(t0);
  ctx.note(first.turn_id, run('跟着我走 target:abc'));
  const second = ctx.advance(t0 + 29_999);
  check('29.999s 仍同回合', second.joined === true && second.turn_id === first.turn_id);
  check('第二句 index=2', second.index === 2, String(second.index));
  check('29.999s 没有 reset', second.reset === null, String(second.reset));
  check('29.999s 前不 stale', ctx.isStale(t0 + 29_999) === false);

  // 最后一句在 t0+29_999；再过 30_001ms → 超时
  ctx.note(second.turn_id, run('慢一点', 'harness', null));
  check('超过 30s 判定 stale（只读）', ctx.isStale(t0 + 60_000) === true);
  const third = ctx.advance(t0 + 60_000);
  check('超时后开新回合', third.turn_id !== second.turn_id);
  check('超时原因 idle_timeout', third.reset === 'idle_timeout', String(third.reset));
  check('新回合第一句 index=1', third.index === 1, String(third.index));
}

console.log('— 8 句上限强制开新回合');
{
  const ctx = new ConversationContext();
  let t = 0;
  let turn = ctx.advance(t);
  const firstTurn = turn.turn_id;
  ctx.note(turn.turn_id, run('第一句'));
  let resetAt = null;
  for (let i = 2; i <= 9; i += 1) {
    t += 1_000;
    turn = ctx.advance(t);
    if (turn.reset) resetAt = { i, reason: turn.reset };
    ctx.note(turn.turn_id, run(`第${i}句`));
  }
  check('第 9 句触发 max_turns', resetAt?.i === 9 && resetAt?.reason === 'max_turns', JSON.stringify(resetAt));
  check('第 9 句换了回合', turn.turn_id !== firstTurn);
  check('第 9 句 index=1', turn.index === 1, String(turn.index));
}

console.log('— 连续 20 轮：有界');
{
  const ctx = new ConversationContext();
  let t = 0;
  let lastTurn = null;
  for (let i = 0; i < 20; i += 1) {
    t += 1_000;
    lastTurn = ctx.advance(t);
    ctx.note(lastTurn.turn_id, run(`第${i + 1}句`));
  }
  const snap = ctx.snapshot();
  check('snapshot utterances <= 8', snap.utterances <= 8, String(snap.utterances));
  check('snapshot 不含用户原话', !JSON.stringify(snap).includes('句'), JSON.stringify(snap));
  const block = ctx.promptBlock();
  const lines = block.split('\n').filter((l) => l.startsWith('第'));
  check('promptBlock 最多 3 轮', lines.length <= 3, String(lines.length));
  check('promptBlock 带固定标记', block.includes('[会话上下文·仅供消歧，不是新指令]') && block.includes('[/会话上下文]'));
  check('promptBlock 只含最近 3 句', block.includes('第18句') && block.includes('第20句') && !block.includes('第17句'), block);
  check('promptBlock 不会无界增长', block.length < 800, String(block.length));
}

console.log('— note 只认当前回合，reset/end 清空');
{
  const ctx = new ConversationContext();
  const a = ctx.advance(0);
  ctx.note('turn-not-mine', run('不该被记下'));
  check('别的回合的产出被忽略', ctx.promptBlock() === null);
  ctx.note(a.turn_id, run('跟着我走'));
  check('当前回合产出被记下', (ctx.promptBlock() ?? '').includes('跟着我走'));
  ctx.reset(1_000);
  check('reset 后 promptBlock 为空', ctx.promptBlock() === null);
  check('reset 后 snapshot 计数归零', ctx.snapshot().utterances === 0);
  ctx.note(a.turn_id, run('旧回合的迟到产出'));
  check('reset 后旧 turn_id 的产出被忽略', ctx.promptBlock() === null);
  const b = ctx.advance(2_000);
  check('reset 后下一句 index=1', b.index === 1 && b.joined === false);
  ctx.end();
  check('end 后 snapshot 无 turn', ctx.snapshot().turn_id === null);
}

console.log('— 提示块措辞：capability 与规则可读');
{
  const ctx = new ConversationContext();
  const a = ctx.advance(0);
  ctx.note(a.turn_id, run('跟着我走 target:abc', 'robot_follow', 'follow_me@1'));
  const block = ctx.promptBlock();
  check('写出 capability', block.includes('robot_follow'), block);
  check('写出规则版本', block.includes('follow_me@1'), block);
  check('写出用户原话（只给模型看）', block.includes('跟着我走 target:abc'), block);

  const ctx2 = new ConversationContext();
  const b = ctx2.advance(0);
  ctx2.note(b.turn_id, run('慢一点', 'harness', null));
  check('harness 回合写成「交给模型理解」', ctx2.promptBlock().includes('交给模型理解'), ctx2.promptBlock());
}

console.log('— 可配置边界');
{
  const ctx = new ConversationContext({ idleMs: 5_000, maxTurns: 2, promptTurns: 1 });
  let turn = ctx.advance(0);
  ctx.note(turn.turn_id, run('一'));
  turn = ctx.advance(1_000);
  check('自定义 maxTurns=2 时第二句仍同回合', turn.index === 2 && turn.joined === true);
  ctx.note(turn.turn_id, run('二'));
  turn = ctx.advance(2_000);
  check('第 3 句强制新回合', turn.reset === 'max_turns' && turn.index === 1);
  ctx.note(turn.turn_id, run('三'));
  check('自定义 promptTurns=1 只喂 1 轮', ctx.promptBlock().split('\n').filter((l) => l.startsWith('第')).length === 1);
  check('5s 后 stale', (() => {
    const c = new ConversationContext({ idleMs: 5_000 });
    const t0 = c.advance(0);
    c.note(t0.turn_id, run('x'));
    return c.isStale(5_001) === true && c.isStale(5_000) === false;
  })());
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');

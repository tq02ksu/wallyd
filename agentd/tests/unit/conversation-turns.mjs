/**
 * 会话上下文接进语音分发的端到端单测（GH-12 验收判据 1/2/3/5/6/7）。
 *
 * 用真实 SQLite + EventLog + RunService + 真 `submitRunRequest` 与规则表，
 * 只把时钟与 Harness 执行器换成可观察的假实现：
 * - 判据 1：`跟着我走 target_track_id:abc` → 5s 内 `慢一点` 必须交给 Harness，并记 turn_joined{count:2}；
 * - 判据 2：间隔 31s 的 `慢一点` 不续回合，记 turn_reset{idle_timeout}；
 * - 判据 3/7：上下文不改变 `matchRoute` 的任何判定，只改变喂给 Harness 的提示块；
 * - 判据 5：conversation.* 事件只有 turn_id/count/reason，没有对话原文；
 * - 判据 6：说 `算了` 不建 run，记 turn_reset{user_ended}，下一句重新从 1 开始。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry } from '../../src/agentd/events.ts';
import { RunService } from '../../src/agentd/runs.ts';
import { ConversationContext } from '../../src/agentd/conversation.ts';
import { submitRunRequest } from '../../src/agentd/run-request.ts';
import { FAST_RULES, matchRoute } from '../../src/agentd/router.ts';

const root = new URL('../../../work/agentd-conversation-test', import.meta.url).pathname;
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

/** 把 fast_rule（`id@version`）还原成能力名；与装配层同一份规则表。 */
function capabilityOf(result) {
  if (result.route !== 'fast' || !result.fast_rule) return 'harness';
  const id = result.fast_rule.split('@')[0];
  return FAST_RULES.find((r) => r.id === id)?.capability ?? 'harness';
}

/**
 * 造一份和 `service.ts` 同构的装配：同一个 ConversationContext 同时被 RunService
 * （回合记账）与 submitUtterance（注记 run 结论 / 取 promptBlock）使用。
 */
function makeEnv(name, { startAt = 0 } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, 'agentd.sqlite'), { log: () => {} });
  const events = new EventLog(store, loadRegistry(), `boot-${name}`);
  const conversation = new ConversationContext();
  let clock = startAt;
  const fastCalls = [];
  const harnessCalls = [];

  const svc = new RunService({
    store,
    events,
    log: () => {},
    conversation,
    now: () => clock,
    submitUtterance: ({ text, utterance_id, turn_id }) => {
      const context = conversation.promptBlock();
      const res = submitRunRequest(
        {
          runs: svc,
          availableCapabilities: () => new Set(['robot_follow', 'robot_stop']),
          log: () => {},
          executeFast: (runId, capability, args) => fastCalls.push({ runId, capability, args }),
          executeHarness: (runId, ctx) => harnessCalls.push({ runId, context: ctx ?? null }),
        },
        {
          prompt: text,
          source: 'asr',
          idempotency_key: `asr:${utterance_id}`,
          context,
        },
      );
      if (turn_id && res.run_id) {
        conversation.note(turn_id, {
          capability: capabilityOf(res),
          fast_rule: res.fast_rule ?? null,
          prompt: text,
        });
      }
      return res;
    },
  });

  const advance = (ms) => {
    clock += ms;
    return clock;
  };
  const speak = (utterance_id, text) =>
    svc.dispatchUtterance({ utterance_id, text, echo: false });
  const transitionSucceeded = (runId) =>
    svc.transition(runId, 'succeeded', { detail: '测试里直接完成', summary: 'ok' });
  const conversationEvents = () =>
    store.all("SELECT type, params_json FROM events WHERE type LIKE 'conversation.%' ORDER BY seq ASC");
  const runCount = () => store.one('SELECT COUNT(*) AS n FROM runs').n;

  return {
    store, events, conversation, svc, fastCalls, harnessCalls,
    advance, speak, transitionSucceeded, conversationEvents, runCount,
    now: () => clock,
  };
}

console.log('— 判据 1：5 秒内「慢一点」续上回合并交给 Harness');
{
  const env = makeEnv('join');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  check('第一句提交成 run', first.action === 'submitted', JSON.stringify(first));
  const firstRow = env.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', first.run_id);
  check('第一句走 fast', firstRow.route === 'fast', JSON.stringify(firstRow));
  check('第一句命中 follow_me@1', firstRow.fast_rule === 'follow_me@1', firstRow.fast_rule);
  env.transitionSucceeded(first.run_id);

  env.advance(5_000);
  const second = env.speak('u2', '慢一点');
  check('第二句提交成 run', second.action === 'submitted', JSON.stringify(second));
  const secondRow = env.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', second.run_id);
  check('第二句 route=harness（不是 fast，也不是被丢弃）', secondRow.route === 'harness', JSON.stringify(secondRow));
  check('第二句没有 fast_rule', secondRow.fast_rule === null, String(secondRow.fast_rule));

  const joined = env.conversationEvents().find((e) => e.type === 'conversation.turn_joined');
  check('写了 conversation.turn_joined', Boolean(joined), JSON.stringify(env.conversationEvents()));
  const joinedParams = joined ? JSON.parse(joined.params_json) : {};
  check('turn_joined count=2', joinedParams.count === 2, JSON.stringify(joinedParams));
  check('turn_joined 带 turn_id', typeof joinedParams.turn_id === 'string' && joinedParams.turn_id.length > 0, JSON.stringify(joinedParams));

  check('Harness 收到上下文块', typeof env.harnessCalls[0]?.context === 'string', JSON.stringify(env.harnessCalls));
  check('上下文块标注仅供消歧', env.harnessCalls[0].context.includes('仅供消歧，不是新指令'), env.harnessCalls[0].context);
  check('上下文块含上一句摘要', env.harnessCalls[0].context.includes('跟着我走 target_track_id:abc'), env.harnessCalls[0].context);
  check('第一句走 fast 时不带上下文', env.harnessCalls.length === 1 && env.fastCalls.length === 1);
}

console.log('— 判据 2：间隔 31 秒的「慢一点」不续回合');
{
  const env = makeEnv('idle');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  env.transitionSucceeded(first.run_id);
  env.advance(31_000);
  const second = env.speak('u2', '慢一点');
  const row = env.store.one('SELECT route FROM runs WHERE run_id = ?', second.run_id);
  check('过期后仍然交给 Harness（不猜）', row.route === 'harness', JSON.stringify(row));
  const events = env.conversationEvents();
  check('没有 turn_joined', !events.some((e) => e.type === 'conversation.turn_joined'), JSON.stringify(events));
  const reset = events.find((e) => e.type === 'conversation.turn_reset');
  check('写了 turn_reset{idle_timeout}', reset ? JSON.parse(reset.params_json).reason === 'idle_timeout' : false, reset?.params_json);
  check('过期后没有上下文块', env.harnessCalls[0]?.context === null, JSON.stringify(env.harnessCalls));
}

console.log('— 判据 1 字面口径：`target:abc` 未命中规则槽时，第二句仍要续上');
{
  // 规则槽只接受 target_track_id/track/目标；`target:abc` 因此首句交给 Harness。
  // 无论首句走 fast 还是 Harness，第二句「慢一点」都必须接上同一回合——判据 1 只要求
  // 「第二个 run 是 harness 且 turn_joined」，并不要求首句必须是 fast。
  const env = makeEnv('literal');
  const first = env.speak('u1', '跟着我走 target:abc');
  const firstRow = env.store.one('SELECT route FROM runs WHERE run_id = ?', first.run_id);
  check('`target:abc` 首句走 harness（规则槽不接受 target）', firstRow.route === 'harness', JSON.stringify(firstRow));
  env.transitionSucceeded(first.run_id);
  env.advance(5_000);
  const second = env.speak('u2', '慢一点');
  const secondRow = env.store.one('SELECT route FROM runs WHERE run_id = ?', second.run_id);
  check('第二句 route=harness', secondRow.route === 'harness', JSON.stringify(secondRow));
  const joined = env.conversationEvents().find((e) => e.type === 'conversation.turn_joined');
  check('第二句 turn_joined count=2', joined ? JSON.parse(joined.params_json).count === 2 : false, joined?.params_json);
  check('第二句上下文块标注仅供消歧', (env.harnessCalls.at(-1)?.context ?? '').includes('仅供消歧，不是新指令'), JSON.stringify(env.harnessCalls.at(-1)));
}

console.log('— 判据 3/7：上下文只影响提示块，不改路由');
{
  const ctx = { available: new Set(['robot_follow', 'robot_stop']), busy: false, speaking: false };
  const baseline = JSON.stringify(matchRoute('慢一点', ctx));
  check('无上下文时「慢一点」是 none', baseline === JSON.stringify({ kind: 'none' }), baseline);

  const env = makeEnv('route');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  env.transitionSucceeded(first.run_id);
  env.advance(2_000);
  const withContext = JSON.stringify(matchRoute('慢一点', ctx));
  check('有上下文时 matchRoute 结果完全相同', withContext === baseline, withContext);

  // 独立指令：无论上下文是否续上，路由必须与空上下文完全一致。
  const env2 = makeEnv('independent');
  const ctx2 = { available: new Set(['robot_follow', 'robot_stop']), busy: false, speaking: false };
  for (const text of ['往前', '停', '跟紧点']) {
    const a = env2.speak(`a-${text}`, text);
    const routeA = a.run_id
      ? env2.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', a.run_id)
      : { route: 'clarified', fast_rule: null };
    const expected = matchRoute(text, ctx2);
    const expectedRoute =
      expected.kind === 'matched' ? 'fast' : expected.kind === 'clarify' || expected.kind === 'ambiguous' ? 'clarified' : 'harness';
    check(`「${text}」route 与空上下文一致`, routeA.route === expectedRoute, `${routeA.route} vs ${expectedRoute}`);
    if (a.run_id) env2.transitionSucceeded(a.run_id);
    env2.advance(1_000);
  }

  // 判据 7 的静态半边：router.ts 不读会话上下文。
  const routerSource = fs.readFileSync(new URL('../../src/agentd/router.ts', import.meta.url), 'utf8');
  check('router.ts 没有引入 ConversationContext', !routerSource.includes('ConversationContext'));
}

console.log('— 判据 6：说「算了」不建 run，回合清空');
{
  const env = makeEnv('end');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  env.transitionSucceeded(first.run_id);
  env.advance(1_000);
  const before = env.runCount();
  const ended = env.speak('u2', '算了');
  check('结束时语法被吞掉', ended.action === 'ignored_empty' && ended.reason === 'conversation_ended', JSON.stringify(ended));
  check('没有建 run', env.runCount() === before, `${before} → ${env.runCount()}`);
  const reset = env.conversationEvents().find((e) => e.type === 'conversation.turn_reset');
  check('写了 turn_reset{user_ended}', reset ? JSON.parse(reset.params_json).reason === 'user_ended' : false, reset?.params_json);

  env.advance(1_000);
  const next = env.speak('u3', '慢一点');
  check('结束后下一句重新提交', next.action === 'submitted', JSON.stringify(next));
  check('下一句没有 turn_joined', !env.conversationEvents().some((e) => e.type === 'conversation.turn_joined'));
  check('下一句没有上下文块', env.harnessCalls.at(-1)?.context === null, JSON.stringify(env.harnessCalls.at(-1)));
}

console.log('— 判据 5：conversation.* 事件不含对话原文');
{
  const env = makeEnv('privacy');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  env.transitionSucceeded(first.run_id);
  env.advance(3_000);
  const second = env.speak('u2', '慢一点');
  env.transitionSucceeded(second.run_id);
  env.advance(1000);
  env.speak('u3', '算了');

  const rows = env.conversationEvents();
  check('确实产生了 conversation 事件', rows.length >= 2, String(rows.length));
  const allowed = new Set(['turn_id', 'count', 'reason']);
  const keys = new Set();
  for (const row of rows) for (const key of Object.keys(JSON.parse(row.params_json))) keys.add(key);
  check('payload 字段只有 turn_id/count/reason', [...keys].every((k) => allowed.has(k)), [...keys].join(','));

  // 只回放 conversation.* 的 payload：它们不能含任何一句用户原话。
  const blob = rows.map((r) => r.params_json).join('\n');
  check('不含「跟着我走」', !blob.includes('跟着我走'), blob);
  check('不含「慢一点」', !blob.includes('慢一点'), blob);
  check('不含「算了」', !blob.includes('算了'), blob);

  // 隐私红线仍然生效：禁列字段写不进去。
  let rejected = false;
  try {
    env.events.emitStandalone({ type: 'conversation.turn_joined', params: { turn_id: 't', count: 1, raw_transcript: 'x' } });
  } catch {
    rejected = true;
  }
  check('forbidden_payload_keys 仍然拦截', rejected);
}

console.log('— 判据 4：连续 20 轮上下文有界（经分发器）');
{
  const env = makeEnv('bounded');
  for (let i = 1; i <= 20; i += 1) {
    const res = env.speak(`u${i}`, '往前走');
    if (res.run_id) env.transitionSucceeded(res.run_id);
    env.advance(1_000);
  }
  const snap = env.conversation.snapshot();
  check('utterances <= 8', snap.utterances <= 8, JSON.stringify(snap));
  const block = env.conversation.promptBlock();
  check('promptBlock 最多 3 轮', block.split('\n').filter((l) => l.startsWith('第')).length <= 3, block);
  const resets = env.conversationEvents().filter(
    (e) => e.type === 'conversation.turn_reset' && JSON.parse(e.params_json).reason === 'max_turns',
  );
  check('20 轮里出现了 max_turns 重置', resets.length >= 2, String(resets.length));
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');

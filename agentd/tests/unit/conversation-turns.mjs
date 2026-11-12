/**
 * 会话上下文接进语音分发的端到端单测（GH-12 验收判据 1/2/3/5/6/7）。
 *
 * 用真实 SQLite + EventLog + RunService + 真 `submitRunRequest` 与规则表，
 * 只把时钟与 Harness 执行器换成可观察的假实现：
 * - 判据 1：`跟着我走 target_track_id:abc` → 5s 内 `慢一点` 命中 slow_down@1（route: fast），并记 turn_joined{index:2}；
 * - 判据 2：间隔 31s 的 `慢一点` 不续回合，记 turn_reset{idle_timeout}；
 * - 判据 3/7：上下文只改变「修饰性规则」的命中（slow_down），不改变其他规则的判定；
 *   交给 Harness 的提示块仍保留，但只用于消歧；
 * - 判据 5：conversation.* 事件只有 turn_id/index/reason，没有对话原文；
 * - 判据 6：说 `算了` 不建 run，记 turn_reset{user_ended}，下一句重新从 1 开始。
 * - 回归（评审缺陷 1）：被忙判定吞掉的句子既不计数、也不写「接上了上一句」。
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
      // 上一轮结论只用于规则消歧（如 slow_down）；过期/新回合时它自然是 null。
      const previous = conversation.previousRun(clock);
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
          previous,
        },
      );
      if (turn_id && res.run_id) {
        conversation.note(turn_id, {
          capability: capabilityOf(res),
          fast_rule: res.fast_rule ?? null,
          prompt: text,
          args: res.fast_args ?? {},
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

console.log('— 判据 1：5 秒内「慢一点」命中 slow_down@1（route: fast）');
{
  const env = makeEnv('join');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  check('第一句提交成 run', first.action === 'submitted', JSON.stringify(first));
  const firstRow = env.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', first.run_id);
  check('第一句走 fast', firstRow.route === 'fast', JSON.stringify(firstRow));
  check('第一句命中 follow_me@1', firstRow.fast_rule === 'follow_me@1', firstRow.fast_rule);
  check('第一句不写 turn_joined（只在真接上上一句时写）', env.conversationEvents().length === 0, JSON.stringify(env.conversationEvents()));
  env.transitionSucceeded(first.run_id);

  env.advance(5_000);
  const second = env.speak('u2', '慢一点');
  check('第二句提交成 run', second.action === 'submitted', JSON.stringify(second));
  const secondRow = env.store.one('SELECT route, fast_rule, prompt FROM runs WHERE run_id = ?', second.run_id);
  check('第二句 route=fast（判据 1：不是 harness）', secondRow.route === 'fast', JSON.stringify(secondRow));
  check('第二句 fast_rule=slow_down@1', secondRow.fast_rule === 'slow_down@1', String(secondRow.fast_rule));
  check('run.prompt 仍是用户原话「慢一点」', secondRow.prompt === '慢一点', secondRow.prompt);

  const fast = env.fastCalls.at(-1);
  check('第二句真的下发给 robot_follow', fast?.capability === 'robot_follow', JSON.stringify(fast));
  check('沿用上一轮的目标 track', fast?.args?.target_track_id === 'abc', JSON.stringify(fast?.args));
  check('速度上限折半（默认 0.15 → 0.075）', fast?.args?.max_speed_mps === 0.075, JSON.stringify(fast?.args));
  check('第二句没有掉进 Harness', env.harnessCalls.length === 0, JSON.stringify(env.harnessCalls));

  const joined = env.conversationEvents().find((e) => e.type === 'conversation.turn_joined');
  check('写了 conversation.turn_joined', Boolean(joined), JSON.stringify(env.conversationEvents()));
  const joinedParams = joined ? JSON.parse(joined.params_json) : {};
  check('turn_joined index=2', joinedParams.index === 2, JSON.stringify(joinedParams));
  check('turn_joined 带 turn_id', typeof joinedParams.turn_id === 'string' && joinedParams.turn_id.length > 0, JSON.stringify(joinedParams));
  check('两句都真的执行了（fastCalls 2 条）', env.fastCalls.length === 2, String(env.fastCalls.length));

  // 再慢一点：上一轮已经是 robot_follow（slow_down 的结论仍是 follow + 更低上限）。
  env.transitionSucceeded(second.run_id);
  env.advance(3_000);
  const third = env.speak('u3', '再慢一点');
  const thirdRow = env.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', third.run_id);
  check('第三句仍 route=fast', thirdRow.route === 'fast', JSON.stringify(thirdRow));
  check('第三句仍命中 slow_down@1', thirdRow.fast_rule === 'slow_down@1', String(thirdRow.fast_rule));
  const thirdFast = env.fastCalls.at(-1);
  check(
    '第三句继续折半但夹在契约下限 0.05',
    thirdFast?.args?.max_speed_mps === 0.05,
    JSON.stringify(thirdFast?.args),
  );
  const joins = env.conversationEvents().filter((e) => e.type === 'conversation.turn_joined');
  check('第三句 turn_joined index=3', joins.length === 2 && JSON.parse(joins[1].params_json).index === 3, JSON.stringify(joins));
}

console.log('— 判据 2：间隔 31 秒的「慢一点」不续回合');
{
  const env = makeEnv('idle');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  env.transitionSucceeded(first.run_id);
  env.advance(31_000);
  const second = env.speak('u2', '慢一点');
  const row = env.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', second.run_id);
  check('过期后仍然交给 Harness（不猜）', row.route === 'harness', JSON.stringify(row));
  check('过期后没有 fast_rule', row.fast_rule === null, String(row.fast_rule));
  const events = env.conversationEvents();
  check('没有 turn_joined', !events.some((e) => e.type === 'conversation.turn_joined'), JSON.stringify(events));
  const reset = events.find((e) => e.type === 'conversation.turn_reset');
  check('写了 turn_reset{idle_timeout}', reset ? JSON.parse(reset.params_json).reason === 'idle_timeout' : false, reset?.params_json);
  check('过期后没有上下文块', env.harnessCalls[0]?.context === null, JSON.stringify(env.harnessCalls));
}

console.log('— 判据 1 边界：首句没走 fast（上一轮不是 robot_follow）时，第二句不猜');
{
  // 规则槽只接受 target_track_id/track/目标；`target:abc` 因此首句交给 Harness。
  // 上一轮的结论是 `harness`，没有可修饰的能力 → 「慢一点」不命中 slow_down，
  // 但回合确实接上了，所以仍写 turn_joined 并把上下文交给模型消歧。
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
  check('第二句 turn_joined index=2', joined ? JSON.parse(joined.params_json).index === 2 : false, joined?.params_json);
  check('第二句上下文块标注仅供消歧', (env.harnessCalls.at(-1)?.context ?? '').includes('仅供消歧，不是新指令'), JSON.stringify(env.harnessCalls.at(-1)));
}

console.log('— 回归（评审缺陷 1）：忙时被吞掉的句子不计数、也不写 conversation 事件');
{
  const env = makeEnv('busy-swallow');
  const active = env.svc.submitRun({ prompt: '正在执行的任务', route: 'harness' });
  env.svc.transition(active.run_id, 'executing');

  const first = env.speak('u1', '等一下');
  const second = env.speak('u2', '慢一点');
  check(
    '两句都被忙判定吞掉',
    first.action === 'ignored_busy' && second.action === 'ignored_busy',
    JSON.stringify([first, second]),
  );
  check('没有写任何 conversation.* 事件', env.conversationEvents().length === 0, JSON.stringify(env.conversationEvents()));
  const snap = env.conversation.snapshot();
  check('snapshot.utterances === 0', snap.utterances === 0, JSON.stringify(snap));
  check('没有为被吞掉的句子开回合', snap.turn_id === null, JSON.stringify(snap));

  // 连续 9 句废话也不能把 MAX_TURNS=8 的配额吃满。
  for (let i = 3; i <= 11; i += 1) env.speak(`u${i}`, '慢一点');
  check('连续 11 句 busy 仍无 conversation 事件', env.conversationEvents().length === 0, JSON.stringify(env.conversationEvents()));
  check('连续 11 句 busy 仍是 0 计数', env.conversation.snapshot().utterances === 0, JSON.stringify(env.conversation.snapshot()));

  // 挡住活动 run 之后，真正落地的那一句从第 1 句起，不会被前面的废话算成「第 10 句」。
  env.svc.cancelRun(active.run_id, '清理');
  env.advance(1_000);
  const real = env.speak('u-real', '跟着我走 target_track_id:abc');
  check('忙结束后第一句照常建 run', real.action === 'submitted', JSON.stringify(real));
  check('这句是回合第 1 句', env.conversation.snapshot().utterances === 1, JSON.stringify(env.conversation.snapshot()));
  check('这句不写 turn_joined', !env.conversationEvents().some((e) => e.type === 'conversation.turn_joined'), JSON.stringify(env.conversationEvents()));

  // 被吞掉的句子也不能漏进喂给模型的上下文块。
  env.transitionSucceeded(real.run_id);
  env.advance(2_000);
  // 用一条仍然交给 Harness 的独立指令来检查提示块；「慢一点」已经改走 slow_down。
  const joinAfterBusy = env.speak('u-next', '往前');
  const block = env.harnessCalls.at(-1)?.context ?? '';
  check('忙结束后第二句照常续上回合', joinAfterBusy.action === 'submitted' && env.conversation.snapshot().utterances === 2, JSON.stringify(env.conversation.snapshot()));
  check(
    '上下文块不含被吞掉的句子',
    !block.includes('等一下') && !block.includes('往前') && block.includes('跟着我走 target_track_id:abc'),
    block,
  );
  check('上下文块仍带仅供消歧标记', block.includes('仅供消歧，不是新指令'), block);
}

console.log('— 回归（评审缺陷 1）：提交竞态 E_BUSY 不写事件、计数回滚');
{
  const dir = path.join(root, 'race');
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, 'agentd.sqlite'), { log: () => {} });
  const events = new EventLog(store, loadRegistry(), 'boot-race');
  const conversation = new ConversationContext();
  const svc = new RunService({
    store,
    events,
    log: () => {},
    conversation,
    now: () => 0,
    submitUtterance: () => {
      // 判定空闲之后、提交之前刚好有 run 变活动（E_BUSY）：这句没有变成 run。
      throw Object.assign(new Error('已有任务在进行中'), { code: 'E_BUSY' });
    },
  });
  const res = svc.dispatchUtterance({ utterance_id: 'race-1', text: '跟着我走 target_track_id:abc', echo: false });
  const conversationRows = store.all("SELECT type FROM events WHERE type LIKE 'conversation.%'");
  check('竞态被降级为 ignored_busy', res.action === 'ignored_busy', JSON.stringify(res));
  check('竞态不写 conversation 事件', conversationRows.length === 0, JSON.stringify(conversationRows));
  const snap = conversation.snapshot();
  check('竞态后计数回滚为 0 且回到无回合', snap.utterances === 0 && snap.turn_id === null, JSON.stringify(snap));
}

console.log('— 判据 3/7：上下文只影响修饰性规则的消歧，不改其他判定');
{
  const ctx = { available: new Set(['robot_follow', 'robot_stop']), busy: false, speaking: false };
  const baseline = JSON.stringify(matchRoute('慢一点', ctx));
  check('无上下文时「慢一点」是 none', baseline === JSON.stringify({ kind: 'none' }), baseline);

  const prevFollow = { ...ctx, previous: { capability: 'robot_follow', args: { target_track_id: 'abc' } } };
  const withContext = JSON.parse(JSON.stringify(matchRoute('慢一点', prevFollow)));
  check(
    '有上下文时「慢一点」变成 slow_down（这正是判据 1 要的消歧）',
    withContext.kind === 'matched' && withContext.rule.id === 'slow_down',
    JSON.stringify(withContext),
  );

  // 独立指令：无论上一轮是什么，路由必须与空上下文完全一致（不被「续」进上一个动作）。
  for (const text of ['往前', '停', '跟紧点', '快一点', '再往前一点', '跟着我走 target_track_id:abc']) {
    const a = JSON.stringify(matchRoute(text, ctx));
    const b = JSON.stringify(matchRoute(text, prevFollow));
    check(`「${text}」的路由与空上下文完全一致`, a === b, `${a} vs ${b}`);
  }

  // 端到端：同一回合里说独立指令，route 与「没有上文」完全一致。
  const env2 = makeEnv('independent');
  const first = env2.speak('u0', '跟着我走 target_track_id:abc');
  check('首句建立 robot_follow 上下文', first.action === 'submitted', JSON.stringify(first));
  env2.transitionSucceeded(first.run_id);
  for (const text of ['往前', '快一点', '再往前一点']) {
    env2.advance(1_000);
    const a = env2.speak(`a-${text}`, text);
    const routeA = a.run_id
      ? env2.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', a.run_id)
      : { route: 'clarified', fast_rule: null };
    const expected = matchRoute(text, ctx);
    const expectedRoute =
      expected.kind === 'matched' ? 'fast' : expected.kind === 'clarify' || expected.kind === 'ambiguous' ? 'clarified' : 'harness';
    check(`「${text}」route 与空上下文一致（${expectedRoute}）`, routeA.route === expectedRoute, `${routeA.route} vs ${expectedRoute}`);
    check(`「${text}」没有被 slow_down 吃掉`, routeA.fast_rule !== 'slow_down@1', String(routeA.fast_rule));
    if (a.run_id) env2.transitionSucceeded(a.run_id);
  }

  // 判据 7 的静态半边：router.ts 不读会话上下文（只通过显式入参）。
  const routerSource = fs.readFileSync(new URL('../../src/agentd/router.ts', import.meta.url), 'utf8');
  check('router.ts 没有引入 ConversationContext', !routerSource.includes('ConversationContext'));

  // 装配层接线：本文件用的是同构的测试装配，生产装配（service.ts）掉线不会让上面的
  // 行为断言变红。这里用源码断言把两条接线钉住（仓库里已有同类静态检查的先例）。
  const serviceSource = fs.readFileSync(new URL('../../src/agentd/service.ts', import.meta.url), 'utf8');
  check(
    'service.ts 把上一轮结论交给路由',
    /previous:\s*conversation\.previousRun\(/.test(serviceSource),
    'service.ts',
  );
  check(
    'service.ts 把命中的参数记回回合上下文',
    /args:\s*res\.fast_args/.test(serviceSource),
    'service.ts',
  );
  check(
    'HTTP /api/run 不把内部 fast_args 返回给调用方',
    /fast_args:\s*_fastArgs/.test(serviceSource),
    'service.ts',
  );
}

console.log('— 判据 6：说「算了」不建 run，回合清空');
{
  const env = makeEnv('end');
  const first = env.speak('u1', '跟着我走 target_track_id:abc');
  env.transitionSucceeded(first.run_id);
  env.advance(1_000);
  const before = env.runCount();
  const ended = env.speak('u2', '算了');
  check('结束时语法被吞掉（独立 action，不与空文本混用）', ended.action === 'conversation_ended' && ended.reason === 'user_ended', JSON.stringify(ended));
  check('没有建 run', env.runCount() === before, `${before} → ${env.runCount()}`);
  const reset = env.conversationEvents().find((e) => e.type === 'conversation.turn_reset');
  check('写了 turn_reset{user_ended}', reset ? JSON.parse(reset.params_json).reason === 'user_ended' : false, reset?.params_json);

  env.advance(1_000);
  const next = env.speak('u3', '慢一点');
  check('结束后下一句重新提交', next.action === 'submitted', JSON.stringify(next));
  check('下一句没有 turn_joined', !env.conversationEvents().some((e) => e.type === 'conversation.turn_joined'));
  const nextRow = env.store.one('SELECT route, fast_rule FROM runs WHERE run_id = ?', next.run_id);
  check('结束后没有上一轮 → 「慢一点」回到 Harness', nextRow.route === 'harness' && nextRow.fast_rule === null, JSON.stringify(nextRow));
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
  const allowed = new Set(['turn_id', 'index', 'reason']);
  const keys = new Set();
  for (const row of rows) for (const key of Object.keys(JSON.parse(row.params_json))) keys.add(key);
  check('payload 字段只有 turn_id/index/reason', [...keys].every((k) => allowed.has(k)), [...keys].join(','));

  // 只回放 conversation.* 的 payload：它们不能含任何一句用户原话。
  const blob = rows.map((r) => r.params_json).join('\n');
  check('不含「跟着我走」', !blob.includes('跟着我走'), blob);
  check('不含「慢一点」', !blob.includes('慢一点'), blob);
  check('不含「算了」', !blob.includes('算了'), blob);

  // 隐私红线仍然生效：禁列字段写不进去。
  let rejected = false;
  try {
    env.events.emitStandalone({ type: 'conversation.turn_joined', params: { turn_id: 't', index: 1, raw_transcript: 'x' } });
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

/**
 * 快速路由的纪律测试。
 *
 * 重点不是「能匹配上」，而是**不能匹配错**：一条错误的快速路由会产生一次真实动作。
 * 所以反例（否定、疑问、前缀污染）比正例更重要。
 */

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

console.log('— 归一化');
check('全角转半角 + 去句末标点', normalizeInput('  停止。 ') === '停止', normalizeInput('  停止。 '));
check('去开头语气词', normalizeInput('嗯，停') === '停', normalizeInput('嗯，停'));

console.log('— 停止：正例');
for (const s of ['停', '停止', '停下来', '快停', '立即停止', '紧急停止', '停一下', '  停止。', '停止！']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ fast`, r.kind === 'matched' && r.rule.id === 'stop_robot', r.kind);
}

console.log('— 停止：反例（这些绝不能触发真实停止）');
for (const s of [
  '不要停',
  '别停',
  '停止了吗',
  '能不能停',
  '可以停吗',
  '不用停',
  '无需停止',
  '待会儿再停吧',     // 带未知尾巴 → 不是明确指令
  '停止跟随',         // 是「停止跟随」还是「停止」+「跟随」？歧义，交给 Harness
  '继续停止',         // 前缀污染
]) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ 不执行`, r.kind !== 'matched', `实际 ${r.kind}`);
}

console.log('— 无匹配 → harness');
for (const s of ['帮我看看这是什么', '你好', '', '  ', '往前走两米']) {
  const r = matchRoute(s, ctx);
  check(`「${s}」→ none`, r.kind === 'none', r.kind);
}

console.log('— 能力不存在 → 澄清（不假装执行）');
{
  const r = matchRoute('停止', { available: new Set(['robot_speak']) });
  check('没有 robot.stop 时澄清', r.kind === 'clarify', r.kind);
  check('澄清说明缺什么', r.kind === 'clarify' && r.missing.includes('capability:robot_stop'), JSON.stringify(r));
}
{
  // 还没探测到能力表（null）→ 不因为「不知道」就拒绝；由执行层在真正调用时报错
  const r = matchRoute('停止', { available: null });
  check('能力表未知时仍可路由', r.kind === 'matched', r.kind);
}

console.log('— 受保护规则优先，扩展规则不能延迟它');
{
  const rules = [
    { ...FAST_RULES[0] },
    {
      id: 'greet',
      version: 1,
      capability: 'robot_speak',
      summary: '打招呼',
      patterns: [/^停止$/u],   // 故意与 STOP 冲突
    },
  ];
  const r = matchRoute('停止', ctx, rules);
  check('冲突时 STOP 胜出', r.kind === 'matched' && r.rule.id === 'stop_robot', JSON.stringify(r));
}

console.log('— 多条非受保护规则同时命中 → 歧义，不按第一条执行');
{
  const rules = [
    { id: 'a', version: 1, capability: 'robot_speak', summary: 'A', patterns: [/^你好$/u] },
    { id: 'b', version: 1, capability: 'robot_speak', summary: 'B', patterns: [/^你好$/u] },
  ];
  const r = matchRoute('你好', ctx, rules);
  check('返回 ambiguous', r.kind === 'ambiguous', r.kind);
  check('列出全部候选', r.kind === 'ambiguous' && r.candidates.length === 2, JSON.stringify(r));
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
  check('澄清给出原因', no.kind === 'clarify' && no.question.includes('任务'), JSON.stringify(no));
}

console.log('— 可追溯标识');
check('ruleTag 带版本', ruleTag(FAST_RULES[0]) === 'stop_robot@1', ruleTag(FAST_RULES[0]));

console.log('');
if (fail > 0) {
  console.log(`${fail} 项失败`);
  process.exit(1);
}
console.log('全部通过');

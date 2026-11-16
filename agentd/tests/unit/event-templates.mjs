/**
 * 事件模板渲染：缺参数时**不许把 `{占位符}` 印给用户**。
 *
 * 现场实测：100 条事件里有 33 条带着 `{duration_ms}` —— 因为桥的 `speech.final`
 * 不带 `audio_ms`，`intOrUndef(p.audio_ms)` 得到 undefined，`fillTemplate` 原样保留
 * `{duration_ms}`，于是页面出现「听音 {duration_ms} 毫秒」。
 *
 * 用户要读的是句子，不是模板残渣。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../src/agentd/store.ts';
import { EventLog, loadRegistry, renderEvent, stripUnfilledPlaceholders } from '../../src/agentd/events.ts';

const root = new URL('../../../work/agentd-events-test', import.meta.url).pathname;
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

console.log('— stripUnfilledPlaceholders：占位符连单位一起去掉');
{
  const cases = [
    ['听音 {duration_ms} 毫秒，没有识别到有效语音（silence）。', '没有识别到有效语音（silence）。'],
    ['用户说：「你好」（时长 {duration_ms} 毫秒）。', '用户说：「你好」。'],
    ['没有占位符，原样返回。', '没有占位符，原样返回。'],
    ['{a} 和 {b} 都没填。', '和都没填。'],
  ];
  for (const [input, want] of cases) {
    const got = stripUnfilledPlaceholders(input);
    check(`${JSON.stringify(input.slice(0, 18))}…`, got === want, `got=${JSON.stringify(got)}`);
  }
  check('不残留任何 {xxx}', !/\{\w+\}/.test(stripUnfilledPlaceholders('{a} {b} {c} 正文')));
  check('不残留空括号', !/（）|\(\s*\)/.test(stripUnfilledPlaceholders('听音 {d} 毫秒（）')));
}

console.log('— 经 renderEvent 走完整链路：缺参数的事件不出现占位符');
{
  const store = new Store(path.join(root, 'agentd.sqlite'), { log: () => {} });
  const registry = loadRegistry();
  const events = new EventLog(store, registry, 'boot-events-test');
  // 照实测那条来：stop_reason 有、duration_ms 缺。
  events.emitStandalone({
    type: 'speech.no_speech',
    params: { utterance_id: 'utt-x', stop_reason: 'silence' },
  });
  const { events: views } = events.query({ limit: 1 });
  const view = views[0];
  check('summary 不含 {duration_ms}', !view.summary.includes('{'), view.summary);
  check('summary 保留了真正有值的 stop_reason', view.summary.includes('silence'), view.summary);
  check('summary 不含空的「毫秒」残壳', !/\s毫秒/.test(view.summary), JSON.stringify(view.summary));
  check('title 正常', view.title === '这一轮没有听到说话', view.title);
}

console.log('— 参数齐全时，值照常填进去（不能把功能删掉）');
{
  const store = new Store(path.join(root, 'agentd2.sqlite'), { log: () => {} });
  const registry = loadRegistry();
  const events = new EventLog(store, registry, 'boot-events-test-2');
  events.emitStandalone({
    type: 'speech.no_speech',
    params: { utterance_id: 'utt-y', stop_reason: 'silence', duration_ms: 1500 },
  });
  const view = events.query({ limit: 1 }).events[0];
  check('duration_ms 有值时照常展示', view.summary.includes('1500'), view.summary);
  check('有值时仍带单位', view.summary.includes('毫秒'), view.summary);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

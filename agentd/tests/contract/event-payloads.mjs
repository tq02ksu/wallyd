/**
 * 事件 payload 契约测试（GH-63）。
 *
 * 与 `events.mjs` 的分工：那个文件核对「实现注册的路由/事件名 == 契约」，
 * 本文件核对**每条事件的 payload 形状**——尤其是可选字段的「可省略」语义。
 * 只读生成物与契约源，不建 HTTP 服务，所以离线/无端口沙箱里也能跑。
 *
 * 判据来源：GH-63 验收判据 2（`speaker_id` 可选）与 4/5（`person.moved` 降频、
 * `person.*` 不进工具面）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEventPayload } from '../../src/agentd/event-payload.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const GEN = path.join(REPO, 'agentd', 'contracts', 'generated');
const SOURCE = path.join(REPO, 'agentd', 'contracts', 'events.json');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const generated = JSON.parse(fs.readFileSync(path.join(GEN, 'events.json'), 'utf8'));
const templates = new Map(generated.templates.map((t) => [t.type, t]));
const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const sourceTemplates = new Map(source.events.map((e) => [e.type, e]));

// ---------------------------------------------------------------- 1. person.* 登记
console.log('— person.* 事件族');
const personEvents = {
  'person.appeared': ['track_id', 'bbox', 'first_seen_at'],
  'person.moved': ['track_id', 'bbox'],
  'person.lost': ['track_id', 'last_seen_at'],
};
for (const [type, fields] of Object.entries(personEvents)) {
  const tpl = templates.get(type);
  check(`${type} 已登记`, Boolean(tpl));
  check(`${type} 必填 ${fields.join('/')}`, fields.every((f) => tpl?.required_fields?.includes(f)), JSON.stringify(tpl?.required_fields));
  check(`${type} 有可读模板`, Boolean(tpl?.title) && Boolean(tpl?.summary));
}

// 观测事实，不是身份判断：这两个名字属于 #50 的后续语义，本条不许出现。
const identityish = [...templates.keys()].filter((t) => /^person\.(identified|recognized|bound)\b/.test(t));
check('没有 person.identified / recognized / bound', identityish.length === 0, identityish.join(', '));

// bbox 是对象，四个数值字段；坐标系与单位由发布端实现 issue 决定（本条不发明）。
for (const type of ['person.appeared', 'person.moved']) {
  const bbox = sourceTemplates.get(type)?.payload?.bbox;
  check(`${type}.bbox 是必填对象`, bbox?.type === 'object' && bbox?.required === true);
  for (const key of ['x', 'y', 'width', 'height']) {
    check(`${type}.bbox.${key} 是必填数值`, bbox?.properties?.[key]?.type === 'number' && bbox?.properties?.[key]?.required === true);
  }
}

// ---------------------------------------------------------------- 2. person.moved 降频
console.log('— person.moved 频率上限写在契约里');
const movedSpec = sourceTemplates.get('person.moved')?.rate_limit;
check('person.moved 声明 rate_limit', Boolean(movedSpec));
check('max_hz 是正数且 ≤5', typeof movedSpec?.max_hz === 'number' && movedSpec.max_hz > 0 && movedSpec.max_hz <= 5, String(movedSpec?.max_hz));
check('window_ms 是正整数', Number.isInteger(movedSpec?.window_ms) && movedSpec.window_ms > 0, String(movedSpec?.window_ms));
check('key_field 指向 payload 字段', movedSpec?.key_field === 'track_id' && Boolean(sourceTemplates.get('person.moved')?.payload?.track_id));
check(
  '生成物带上了 rate_limit（运行时读生成物，不读源码）',
  templates.get('person.moved')?.rate_limit?.max_hz === movedSpec?.max_hz,
  JSON.stringify(templates.get('person.moved')?.rate_limit),
);

// ---------------------------------------------------------------- 3. payload 校验
console.log('— person.* payload 校验');
const appearedSpec = sourceTemplates.get('person.appeared')?.payload;
const okAppeared = {
  track_id: 't-1',
  bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
  first_seen_at: '2026-11-11T00:00:00.000Z',
};
check('person.appeared 合法 payload 通过', validateEventPayload(appearedSpec, okAppeared).length === 0, JSON.stringify(validateEventPayload(appearedSpec, okAppeared)));
check(
  'person.appeared 缺 first_seen_at 被拒',
  validateEventPayload(appearedSpec, { track_id: 't-1', bbox: okAppeared.bbox }).length > 0,
);
check(
  'person.appeared bbox 缺 height 被拒',
  validateEventPayload(appearedSpec, { ...okAppeared, bbox: { x: 0, y: 0, width: 1 } }).length > 0,
);
const lostSpec = sourceTemplates.get('person.lost')?.payload;
check('person.lost 合法 payload 通过', validateEventPayload(lostSpec, { track_id: 't-1', last_seen_at: '2026-11-11T00:00:03.000Z' }).length === 0);
const movedPayloadSpec = sourceTemplates.get('person.moved')?.payload;
check('person.moved 合法 payload 通过', validateEventPayload(movedPayloadSpec, { track_id: 't-1', bbox: okAppeared.bbox }).length === 0);
check('person.moved 缺 track_id 被拒', validateEventPayload(movedPayloadSpec, { bbox: okAppeared.bbox }).length > 0);

// ---------------------------------------------------------------- 4. speaker_id 可选
console.log('— speech.utterance_heard.speaker_id 是可选字段');
const heard = templates.get('speech.utterance_heard');
const heardSpec = sourceTemplates.get('speech.utterance_heard')?.payload;
check('speaker_id 已登记', heard?.payload_fields?.includes('speaker_id') === true);
check('speaker_id 不是必填', heard?.required_fields?.includes('speaker_id') !== true);
check('speaker_id 类型是 string', heardSpec?.speaker_id?.type === 'string');
check('speaker_id 声明为可选', heardSpec?.speaker_id?.required !== true);

const withoutSpeaker = { utterance_id: 'u-1', excerpt: '你好', chars: 2 };
const withSpeaker = { ...withoutSpeaker, speaker_id: 'spk-abc' };
check('不带 speaker_id：契约校验通过', validateEventPayload(heardSpec, withoutSpeaker).length === 0, JSON.stringify(validateEventPayload(heardSpec, withoutSpeaker)));
check('带上 speaker_id：契约校验通过', validateEventPayload(heardSpec, withSpeaker).length === 0, JSON.stringify(validateEventPayload(heardSpec, withSpeaker)));
check('speaker_id 为 null 被拒（未实现时省略，不填 null）', validateEventPayload(heardSpec, { ...withoutSpeaker, speaker_id: null }).length > 0);
check('speaker_id 非字符串被拒', validateEventPayload(heardSpec, { ...withoutSpeaker, speaker_id: 42 }).length > 0);

// 反向判据：把 speaker_id 改成必填，同一份「不带它」的 payload 必须变红。
// 这样契约一旦被改成必填，本测试自己就会失败，不需要人去手工改字段。
const requiredVariant = {
  ...heardSpec,
  speaker_id: { ...heardSpec.speaker_id, required: true },
};
check(
  '反向判据：speaker_id 改成必填后，不带它的 payload 校验失败',
  validateEventPayload(requiredVariant, withoutSpeaker).length > 0,
);

// ---------------------------------------------------------------- 5. 不进工具面
console.log('— person.* 不得进入模型工具面');
const toolsPath = path.join(REPO, 'contracts', 'generated', 'mcp-tools.json');
const toolsText = fs.readFileSync(toolsPath, 'utf8');
for (const type of Object.keys(personEvents)) {
  check(`mcp-tools.json 不含 ${type}`, !toolsText.includes(type));
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 项失败`);
  process.exit(1);
}
console.log('全部通过');

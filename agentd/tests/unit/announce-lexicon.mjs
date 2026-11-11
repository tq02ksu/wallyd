/**
 * 审批复述词表（agentd 侧）：
 * - 数字必须变成词表规定的中文读法（0.15 → 零点一五），不能把 TTS 的随机读法带上审批链路；
 * - 单位必须来自同一份 contracts/announce-lexicon.json；
 * - 超长/含糊/科学计数法/英文缩写一律拒绝，而不是交给 TTS。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEXICON_PATH,
  LexiconError,
  formatArgsSummary,
  loadLexicon,
  validateArgsSummary,
} from '../../../contracts/tools/announce-lexicon.mjs';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}
function rejects(name, fn, needle) {
  try {
    fn();
    check(name, false, '没有拒绝');
  } catch (e) {
    check(name, e instanceof LexiconError && (!needle || String(e.message).includes(needle)), e?.message);
  }
}

console.log('— 词表是唯一真值');
{
  const lex = loadLexicon();
  check('契约文件存在', fs.existsSync(LEXICON_PATH));
  check('上限是 60 字', lex.args_summary.max_chars === 60, lex.args_summary.max_chars);
  check('重复上限是 3 次', lex.repeat.max_attempts === 3, lex.repeat.max_attempts);
}

console.log('— 数字 + 单位读法');
{
  check(
    '0.15 米每秒 + 2 米',
    formatArgsSummary({ speed_mps: 0.15, max_distance_m: 2 }, ['speed_mps', 'max_distance_m']) ===
      '速度零点一五米每秒，最远距离二米',
    formatArgsSummary({ speed_mps: 0.15, max_distance_m: 2 }, ['speed_mps', 'max_distance_m']),
  );
  check(
    '30 → 三十',
    formatArgsSummary({ max_distance_m: 30 }, ['max_distance_m']) === '最远距离三十米',
    formatArgsSummary({ max_distance_m: 30 }, ['max_distance_m']),
  );
  check(
    '350 毫米',
    formatArgsSummary({ wheelbase_mm: 350 }, ['wheelbase_mm']) === '轴距三百五十毫米',
    formatArgsSummary({ wheelbase_mm: 350 }, ['wheelbase_mm']),
  );
  check(
    '负数',
    formatArgsSummary({ angle_deg: -15 }, ['angle_deg']) === '角度负十五度',
    formatArgsSummary({ angle_deg: -15 }, ['angle_deg']),
  );
  check(
    '文本字段',
    formatArgsSummary({ target_track_id: 't7' }, ['target_track_id', 'target']) === '目标：t7',
    formatArgsSummary({ target_track_id: 't7' }, ['target_track_id', 'target']),
  );
  check(
    '以 m 开头的目标 ID 不被当成单位',
    formatArgsSummary({ target_track_id: 'm7' }, ['target_track_id']) === '目标：m7',
    formatArgsSummary({ target_track_id: 'm7' }, ['target_track_id']),
  );
}

console.log('— 拒绝含糊/超长/未读数字');
{
  rejects('走一点点', () => validateArgsSummary('走一点点'), '不确定词');
  rejects('大约二米', () => validateArgsSummary('大约二米'), '不确定词');
  rejects('左右', () => validateArgsSummary('左右'), '不确定词');
  rejects('0.15 米每秒', () => validateArgsSummary('0.15 米每秒'), '阿拉伯数字');
  rejects('2.0 米', () => validateArgsSummary('2.0 米'), '阿拉伯数字');
  rejects('1e-3 米', () => validateArgsSummary('1e-3 米'), '阿拉伯数字');
  rejects('全角数字', () => validateArgsSummary('０.１５ 米'), '非 ASCII 数字');
  rejects('罗马数字', () => validateArgsSummary('第八Ⅷ步'), '非 ASCII 数字');
  rejects('二 m', () => validateArgsSummary('二 m'), '英文单位');
  rejects('61 字', () => validateArgsSummary('甲'.repeat(61)), '超过 60 字');
  rejects('未知字段', () => formatArgsSummary({ servo_pin: 3 }, ['servo_pin']), '没有词表读法');
  rejects('小数位过多', () => formatArgsSummary({ speed_mps: 0.1234 }, ['speed_mps']), '小数位');
  rejects('单个文本参数拼不下', () => formatArgsSummary({ text: '甲'.repeat(60) }, ['text']), '超过 60 字');
}

console.log('— 改一处数字读法：同一份词表驱动输出');
{
  const lex = JSON.parse(fs.readFileSync(LEXICON_PATH, 'utf8'));
  const before = formatArgsSummary({ speed_mps: 0.15 }, ['speed_mps'], lex);
  lex.digits['1'] = '幺';
  const after = formatArgsSummary({ speed_mps: 0.15 }, ['speed_mps'], lex);
  check('默认读法', before === '速度零点一五米每秒', before);
  check('改动后输出跟着变', after === '速度零点幺五米每秒', after);
  const tmp = path.join(os.tmpdir(), `wally-lexicon-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(lex));
  const viaFile = formatArgsSummary({ speed_mps: 0.15 }, ['speed_mps'], loadLexicon(tmp));
  check('从临时词表加载也变', viaFile === after, viaFile);
  fs.rmSync(tmp, { force: true });
}

if (failed) {
  console.log(`FAILED: ${failed}`);
  process.exit(1);
}
console.log('OK announce-lexicon');

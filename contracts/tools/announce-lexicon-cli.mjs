#!/usr/bin/env node
// 跨端一致性 CLI：stdin 给 {"args":{...},"fields":[...]}，stdout 输出拼好的 args_summary。
// `--rules <path>` 可指向临时词表（用于证明「改一处读法，两端同时变」）。
import { formatArgsSummary, loadLexicon, validateArgsSummary } from './announce-lexicon.mjs';

const argv = process.argv.slice(2);
const rulesIndex = argv.indexOf('--rules');
const rulesPath = rulesIndex >= 0 ? argv[rulesIndex + 1] : undefined;
const mode = argv.includes('--validate') ? 'validate' : 'format';
const batch = argv.includes('--batch');

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw || '{}');
} catch (e) {
  console.error(`输入不是 JSON：${e.message}`);
  process.exit(2);
}

try {
  const lex = loadLexicon(rulesPath);
  if (batch) {
    const results = (input.cases ?? []).map((item) =>
      formatArgsSummary(item.args ?? {}, item.fields ?? [], lex),
    );
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } else {
    const text = mode === 'validate'
      ? validateArgsSummary(String(input.summary ?? ''), lex)
      : formatArgsSummary(input.args ?? {}, input.fields ?? [], lex);
    process.stdout.write(`${text}\n`);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

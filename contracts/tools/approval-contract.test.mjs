// 生成器对审批声明的护栏测试（GH-22 判据 2 与《待确认项》第 1 条）：
// - 改一个被声明为 approvalParams 的字段名 → 生成失败（contract:check 会红）；
// - 旧布尔 true 仍被接受（视同 params: []），但必须 warning，不红。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8');
const EVENTS = path.join(ROOT, 'events.json');
const SPEAK_PARAMS = 'params: [text, voice, rate, interruptible]';

function runGenerator(yamlText) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-contract-test-'));
  const yamlPath = path.join(tmp, 'openapi.yaml');
  fs.writeFileSync(yamlPath, yamlText);
  const out = path.join(tmp, 'generated');
  const diagnosticsPath = path.join(tmp, 'diagnostics.txt');
  const result = spawnSync(process.execPath, [path.join(HERE, 'generate.mjs')], {
    env: {
      ...process.env,
      CONTRACT_OPENAPI_YAML: yamlPath,
      CONTRACT_EVENTS_JSON: EVENTS,
      CONTRACT_OUT_DIR: out,
      CONTRACT_DIAGNOSTICS_FILE: diagnosticsPath,
    },
    encoding: 'utf8',
  });
  const toolsPath = path.join(out, 'mcp-tools.json');
  const tools = fs.existsSync(toolsPath) ? JSON.parse(fs.readFileSync(toolsPath, 'utf8')) : null;
  const diagnostics = fs.existsSync(diagnosticsPath) ? fs.readFileSync(diagnosticsPath, 'utf8') : '';
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ...result, tools, diagnostics };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}`, e.message);
  }
}

console.log('— approvalParams 字段名必须真实存在于 requestBody schema');
{
  const mutated = SOURCE.replace(SPEAK_PARAMS, 'params: [txet]');
  assert.notEqual(mutated, SOURCE, '测试夹具没改到目标行');
  const result = runGenerator(mutated);
  check('字段改名 → 生成失败', () => {
    assert.equal(result.status, 1);
    assert.match(result.diagnostics, /FAIL .*txet/);
  });
}

console.log('— 旧布尔写法的迁移护栏');
{
  const mutated = SOURCE.replace(
    /x-requires-approval:\n\s+params: \[text, voice, rate, interruptible\]/,
    'x-requires-approval: true',
  );
  assert.notEqual(mutated, SOURCE, '测试夹具没改到目标行');
  const result = runGenerator(mutated);
  check('布尔 true 不失败', () => assert.equal(result.status, 0, result.diagnostics));
  check('布尔 true 报 warning', () => assert.match(result.diagnostics, /WARN contract: robot_speak/));
  check('生成物只有 approvalParams: []', () => {
    const speak = result.tools.find((t) => t.name === 'robot_speak');
    assert.deepEqual(speak.approvalParams, []);
    assert.ok(!('requiresApproval' in speak));
  });
}

console.log('— 对象形态只允许 params 键');
{
  const mutated = SOURCE.replace(SPEAK_PARAMS, 'params: [text]\n        extra: true');
  const result = runGenerator(mutated);
  check('未知键 → 生成失败', () => {
    assert.equal(result.status, 1);
    assert.match(result.diagnostics, /FAIL .*extra/);
  });
}

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('approval contract checks passed');

#!/usr/bin/env node
/**
 * Regression tests for the CI configuration itself.
 *
 * Two things had no test coverage:
 *   1. `lint-sources.mjs` — the syntax gate could silently stop rejecting bad
 *      sources (or start rejecting good ones) and CI would stay green.
 *   2. `.github/workflows/quality.yml` — branch protection depends on a single
 *      aggregate `quality` job. If a lane is dropped, or the aggregate stops
 *      depending on every lane, the required check can pass while a whole test
 *      suite never ran.
 *
 * The linter is exercised in-process through its exported pure functions, so
 * this file has no child-process or network dependency.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { checkWorkflowShape, classifySource, lintSources } from './lint-sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

let failed = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`, extra ?? '');
  }
}

const goodWorkflow = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n';

/**
 * Run the linter over a temporary file tree. External syntax checks are
 * stubbed so the test exercises routing and error collection, not Node/Bash.
 */
function lintFixture(files, syntaxErrors = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wally-lint-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const calls = [];
    const run = (command, args) => {
      const rel = args[args.length - 1];
      calls.push(`${path.basename(command)} ${rel}`);
      return syntaxErrors[rel] ?? null;
    };
    const result = lintSources({ root: dir, files: Object.keys(files), run });
    return { ...result, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('— lint-sources');

const clean = lintFixture({
  'ok.js': 'export const answer = 42;\n',
  'ok.sh': '#!/usr/bin/env bash\nset -euo pipefail\necho ok\n',
  'ok.json': '{"ok":true}\n',
  'ok.yaml': 'name: ok\n',
  'README.md': 'not a source file\n',
  '.github/workflows/ok.yml': goodWorkflow,
});
check('classifies Node/shell/JSON/YAML and ignores the rest', JSON.stringify(clean.counts) === JSON.stringify({ node: 1, shell: 1, json: 1, yaml: 2 }), JSON.stringify(clean.counts));
check('accepts valid sources', clean.failures.length === 0, clean.failures.join('\n'));
check('routes .js through node --check', clean.calls.includes('node ok.js'), clean.calls.join(', '));
check('routes .sh through bash -n', clean.calls.includes('bash ok.sh'), clean.calls.join(', '));
check('returns null for files with no syntax check', classifySource('README.md') === null);

const brokenJs = lintFixture({ 'bad.js': 'const = ;\n' }, { 'bad.js': 'SyntaxError: Unexpected token' });
check('rejects a JavaScript syntax error', brokenJs.failures.length === 1, JSON.stringify(brokenJs.failures));
check('names the broken JavaScript file', /bad\.js/.test(brokenJs.failures.join('\n')), brokenJs.failures.join('\n'));

const brokenShell = lintFixture({ 'bad.sh': 'if then\n' }, { 'bad.sh': 'bash: syntax error' });
check('rejects a shell syntax error', brokenShell.failures.length === 1, JSON.stringify(brokenShell.failures));

const brokenJson = lintFixture({ 'bad.json': '{"unterminated":\n' });
check('rejects malformed JSON', brokenJson.failures.length === 1, JSON.stringify(brokenJson.failures));

const brokenYaml = lintFixture({ 'bad.yaml': 'a: [1,\n' });
check('rejects malformed YAML', brokenYaml.failures.length === 1, JSON.stringify(brokenYaml.failures));

const noJobs = lintFixture({ '.github/workflows/no-jobs.yml': 'on: push\n' });
check('rejects a workflow without jobs', /no jobs mapping/.test(noJobs.failures.join('\n')), noJobs.failures.join('\n'));

const noRunsOn = lintFixture({
  '.github/workflows/no-runs-on.yml': 'on: push\njobs:\n  build:\n    steps:\n      - run: echo ok\n',
});
check('rejects a job without runs-on/uses', /neither "runs-on" nor "uses"/.test(noRunsOn.failures.join('\n')), noRunsOn.failures.join('\n'));

const noTrigger = lintFixture({ '.github/workflows/no-trigger.yml': goodWorkflow.replace('on: push\n', '') });
check('rejects a workflow without a trigger', /no trigger/.test(noTrigger.failures.join('\n')), noTrigger.failures.join('\n'));

check('rejects a workflow that is not a mapping', checkWorkflowShape('x.yml', ['nope']).length === 1);

console.log('— .github/workflows/quality.yml');

const workflowPath = path.join(root, '.github', 'workflows', 'quality.yml');
const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
const jobs = workflow?.jobs ?? {};
const lanes = ['static', 'robotd', 'agentd', 'integration'];

check('the workflow passes its own shape check', checkWorkflowShape('quality.yml', workflow).length === 0, checkWorkflowShape('quality.yml', workflow).join('; '));
for (const lane of lanes) {
  check(`has a "${lane}" lane`, Boolean(jobs[lane]), Object.keys(jobs).join(', '));
}
check('has the aggregate "quality" job', Boolean(jobs.quality), Object.keys(jobs).join(', '));
check('quality runs unconditionally', jobs.quality?.if === 'always()', String(jobs.quality?.if));
check(
  'quality depends on every lane',
  JSON.stringify([...(jobs.quality?.needs ?? [])].sort()) === JSON.stringify([...lanes].sort()),
  JSON.stringify(jobs.quality?.needs ?? []),
);

const referencedScripts = new Set();
for (const job of Object.values(jobs)) {
  for (const step of job.steps ?? []) {
    for (const match of String(step.run ?? '').matchAll(/(scripts\/ci\/[\w.-]+\.sh)/g)) {
      referencedScripts.add(match[1]);
    }
  }
}
check('CI invokes at least the four lane scripts', referencedScripts.size >= 4, [...referencedScripts].join(', '));
for (const script of referencedScripts) {
  check(`referenced script exists: ${script}`, existsSync(path.join(root, script)));
}

const staticScript = readFileSync(path.join(root, 'scripts', 'ci', 'check-static.sh'), 'utf8');
check('the static lane runs these tests', /node scripts\/ci\/ci-config\.test\.mjs/.test(staticScript));

console.log(failed === 0 ? '\nCI configuration tests passed' : `\n${failed} CI configuration test(s) failed`);
process.exit(failed === 0 ? 0 : 1);

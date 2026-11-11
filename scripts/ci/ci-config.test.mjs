#!/usr/bin/env node
/**
 * Regression tests for the CI configuration itself.
 *
 * Three things had no test coverage:
 *   1. `lint-sources.mjs` — the syntax gate could silently stop rejecting bad
 *      sources (or start rejecting good ones) and CI would stay green.
 *   2. `.github/workflows/quality.yml` — branch protection depends on a single
 *      aggregate `quality` job. If a lane is dropped, or the aggregate stops
 *      depending on every lane, the required check can pass while a whole test
 *      suite never ran.
 *   3. The `scripts/ci/check-*.sh` lane scripts — a lane that loses
 *      `set -euo pipefail` can run a failing suite and still exit 0, and a
 *      gutted script can report success without running anything.
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
import { LANES, verifyLaneResults } from './verify-lanes.mjs';

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
  'ok.py': 'print("ok")\n',
  'ok.json': '{"ok":true}\n',
  'ok.yaml': 'name: ok\n',
  'README.md': 'not a source file\n',
  '.github/workflows/ok.yml': goodWorkflow,
});
check('classifies Node/shell/Python/JSON/YAML and ignores the rest', JSON.stringify(clean.counts) === JSON.stringify({ node: 1, shell: 1, python: 1, json: 1, yaml: 2 }), JSON.stringify(clean.counts));
check('accepts valid sources', clean.failures.length === 0, clean.failures.join('\n'));
check('routes .js through node --check', clean.calls.includes('node ok.js'), clean.calls.join(', '));
check('routes .sh through bash -n', clean.calls.includes('bash ok.sh'), clean.calls.join(', '));
check('routes .py through the Python parser', clean.calls.includes('python3 ok.py'), clean.calls.join(', '));
check('returns null for files with no syntax check', classifySource('README.md') === null);

const brokenJs = lintFixture({ 'bad.js': 'const = ;\n' }, { 'bad.js': 'SyntaxError: Unexpected token' });
check('rejects a JavaScript syntax error', brokenJs.failures.length === 1, JSON.stringify(brokenJs.failures));
check('names the broken JavaScript file', /bad\.js/.test(brokenJs.failures.join('\n')), brokenJs.failures.join('\n'));

const brokenShell = lintFixture({ 'bad.sh': 'if then\n' }, { 'bad.sh': 'bash: syntax error' });
check('rejects a shell syntax error', brokenShell.failures.length === 1, JSON.stringify(brokenShell.failures));

const brokenPython = lintFixture({ 'bad.py': 'def broken(:\n' }, { 'bad.py': 'SyntaxError: invalid syntax' });
check('rejects a Python syntax error', brokenPython.failures.length === 1, JSON.stringify(brokenPython.failures));
check('names the broken Python file', /bad\.py/.test(brokenPython.failures.join('\n')), brokenPython.failures.join('\n'));

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
// Every lane the required `quality` check must see. `verify-lanes.mjs` owns the
// list; the wiring block further down pins it against the workflow, so adding a
// job without wiring it (or wiring it without adding it here) fails this file.
const lanes = LANES;
// Lanes that can run on a Linux workstation. `apple` needs Xcode, so it is
// CI-only and intentionally absent from `run-gates.sh`.
const linuxLanes = ['static', 'robotd', 'agentd', 'integration'];

check('the workflow passes its own shape check', checkWorkflowShape('quality.yml', workflow).length === 0, checkWorkflowShape('quality.yml', workflow).join('; '));
// A workflow with no usable trigger never runs, and a required check that never
// runs sits at "expected" forever. Pin the events and the stale-run behaviour
// the repository relies on.
const triggers = workflow?.on ?? {};
check('runs on pull requests', triggers.pull_request !== undefined, JSON.stringify(triggers));
check('runs on pushes to main', Array.isArray(triggers.push?.branches) && triggers.push.branches.includes('main'), JSON.stringify(triggers.push));
check('can be dispatched manually', triggers.workflow_dispatch !== undefined, JSON.stringify(triggers));
// `pull_request_target` runs with a write token and repository secrets while
// checking out untrusted fork code. This workflow only needs to read the
// checkout, so the safe `pull_request` trigger is the only one allowed here.
check(
  'does not run on pull_request_target',
  triggers.pull_request_target === undefined,
  JSON.stringify(triggers),
);
check('supersedes stale runs', workflow?.concurrency?.['cancel-in-progress'] === true, JSON.stringify(workflow?.concurrency));
// `continue-on-error` turns a broken lane green, which is exactly the failure
// the aggregate `quality` job exists to prevent.
const masked = [];
for (const [jobId, job] of Object.entries(jobs)) {
  if (job?.['continue-on-error']) masked.push(`${jobId} job`);
  for (const [index, step] of (job?.steps ?? []).entries()) {
    if (step?.['continue-on-error']) masked.push(`${jobId} step ${index + 1}`);
  }
}
check('no job or step masks failures', masked.length === 0, masked.join(', '));
// A lane that is conditionally skipped still reports `success` to its
// dependents, and the aggregate `quality` job only fails on a lane result that
// is not success. So an `if:` that quietly disables a lane keeps the required
// check green while nothing ran. Only the aggregate job may be conditional
// (`always()`), which is what makes it report on a failed lane at all.
const conditional = [];
for (const lane of lanes) {
  if (jobs[lane]?.if !== undefined) conditional.push(`${lane} job`);
  for (const [index, step] of (jobs[lane]?.steps ?? []).entries()) {
    if (step?.if !== undefined) conditional.push(`${lane} step ${index + 1}`);
  }
}
for (const [index, step] of (jobs.quality?.steps ?? []).entries()) {
  if (step?.if !== undefined) conditional.push(`quality step ${index + 1}`);
}
check('no lane job or step is conditionally skipped', conditional.length === 0, conditional.join(', '));
for (const lane of lanes) {
  check(`has a "${lane}" lane`, Boolean(jobs[lane]), Object.keys(jobs).join(', '));
}
check('has the aggregate "quality" job', Boolean(jobs.quality), Object.keys(jobs).join(', '));
// Branch protection targets the check's *display name*, not the job id. If the
// `name:` were dropped or renamed, the required check would sit at "expected"
// while every lane passed, so pin the name the repository documents.
check(
  'the required check is named "quality"',
  jobs.quality?.name === 'quality',
  String(jobs.quality?.name),
);
check('quality runs unconditionally', jobs.quality?.if === 'always()', String(jobs.quality?.if));
check(
  'quality depends on every lane',
  JSON.stringify([...(jobs.quality?.needs ?? [])].sort()) === JSON.stringify([...lanes].sort()),
  JSON.stringify(jobs.quality?.needs ?? []),
);
// --- lane wiring must stay in lockstep -------------------------------------
// Three places decide whether a lane can turn the required check red:
// `verify-lanes.mjs` must read it (LANES), `quality.needs` must wait for it,
// and the aggregate step's `env` must actually forward its result. Dropping any
// one of them leaves branch protection green while a lane failed or never ran.
const qualityEnv = Object.assign(
  {},
  ...(jobs.quality?.steps ?? []).map((step) => step.env ?? {}),
);
for (const lane of LANES) {
  check(
    `quality needs the "${lane}" lane`,
    (jobs.quality?.needs ?? []).includes(lane),
    JSON.stringify(jobs.quality?.needs ?? []),
  );
  check(
    `quality forwards the "${lane}" result to verify-lanes`,
    String(qualityEnv[lane.toUpperCase()] ?? '').replace(/\s+/g, '') ===
      '${{needs.' + lane + '.result}}',
    JSON.stringify(qualityEnv),
  );
}
check(
  'quality needs nothing outside LANES',
  [...(jobs.quality?.needs ?? [])].every((lane) => LANES.includes(lane)),
  JSON.stringify(jobs.quality?.needs ?? []),
);
check(
  'quality env carries nothing outside LANES',
  Object.keys(qualityEnv).every((key) => LANES.includes(key.toLowerCase())),
  JSON.stringify(Object.keys(qualityEnv)),
);
// A `paths:` filter on the workflow would let a PR that touches no Swift file
// merge without ever compiling Swift — the false green GH-36 exists to remove.
check(
  'the workflow is not path-filtered',
  triggers.pull_request?.paths === undefined && triggers.push?.paths === undefined,
  JSON.stringify(triggers),
);
// GH-36: the whole point of the `apple` lane is a macOS compiler. Pin the
// official arm64 image (never `macos-13`/x86_64, never a self-hosted runner) and
// the 15-minute budget the issue sets.
check(
  'the apple lane runs on the official macOS image',
  jobs.apple?.['runs-on'] === 'macos-latest',
  String(jobs.apple?.['runs-on']),
);
check(
  'the apple lane is bounded to 15 minutes',
  jobs.apple?.['timeout-minutes'] === 15,
  String(jobs.apple?.['timeout-minutes']),
);
// The aggregate job is the only place a failing lane becomes a failing
// required check. If its step stops evaluating the results (or loses the
// checkout that provides the script), branch protection goes green anyway.
const qualityCommands = (jobs.quality?.steps ?? []).map((step) => String(step.run ?? '')).join('\n');
check(
  'quality evaluates the lane results with the tested script',
  qualityCommands.includes('node scripts/ci/verify-lanes.mjs'),
  qualityCommands,
);
check(
  'quality checks out the repository for that script',
  (jobs.quality?.steps ?? []).some((step) => step.uses === 'actions/checkout@v4'),
  JSON.stringify(jobs.quality?.steps ?? []),
);

const allGreen = Object.fromEntries(LANES.map((lane) => [lane, 'success']));
check('lane results: all success passes', verifyLaneResults(allGreen).length === 0, JSON.stringify(verifyLaneResults(allGreen)));
for (const lane of LANES) {
  const problems = verifyLaneResults({ ...allGreen, [lane]: 'failure' });
  check(`lane results: a failed "${lane}" lane fails`, problems.length === 1 && problems[0].startsWith(`${lane}:`), JSON.stringify(problems));
}
check(
  'lane results: cancelled and skipped lanes fail',
  verifyLaneResults({ ...allGreen, robotd: 'cancelled' }).length === 1 &&
    verifyLaneResults({ ...allGreen, agentd: 'skipped' }).length === 1,
  JSON.stringify(verifyLaneResults({ ...allGreen, robotd: 'cancelled' })),
);
check(
  'lane results: a missing result fails',
  verifyLaneResults({ static: 'success' }).length === LANES.length - 1,
  JSON.stringify(verifyLaneResults({ static: 'success' })),
);
// A workflow defaults to broad token permissions and to GitHub's 6h job
// timeout. Both are silent failure modes: an over-privileged token can write
// to the repo, and a hung test lane burns runner minutes until the default
// cutoff. Keep the workflow read-only and every job bounded.
check(
  'workflow permissions are read-only',
  JSON.stringify(workflow?.permissions ?? {}) === JSON.stringify({ contents: 'read' }),
  JSON.stringify(workflow?.permissions ?? null),
);
// Job-level `permissions:` replaces the workflow-level value instead of merging
// with it, so a lane can regain write access while the workflow stays
// read-only. Any job that declares permissions must keep the same shape.
const widenedPermissions = [];
for (const [jobId, job] of Object.entries(jobs)) {
  if (job?.permissions === undefined) continue;
  if (JSON.stringify(job.permissions) !== JSON.stringify({ contents: 'read' })) {
    widenedPermissions.push(`${jobId}: ${JSON.stringify(job.permissions)}`);
  }
}
check('no job widens workflow permissions', widenedPermissions.length === 0, widenedPermissions.join(', '));
for (const jobId of [...lanes, 'quality']) {
  const timeout = jobs[jobId]?.['timeout-minutes'];
  check(`"${jobId}" job declares a timeout`, Number.isInteger(timeout) && timeout > 0, String(timeout));
}
// A reusable action pinned to a branch (`@main`) can change under us between
// runs; CI must only consume reviewed, tagged refs.
const branchPinned = [];
for (const [jobId, job] of Object.entries(jobs)) {
  for (const step of job?.steps ?? []) {
    if (typeof step.uses === 'string' && /@(?:main|master|HEAD)$/i.test(step.uses)) {
      branchPinned.push(`${jobId}: ${step.uses}`);
    }
  }
}
check('actions are pinned to a tag, not a branch', branchPinned.length === 0, branchPinned.join(', '));
for (const lane of lanes) {
  const commands = (jobs[lane]?.steps ?? []).map((step) => String(step.run ?? '')).join('\n');
  check(
    `"${lane}" lane runs its own gate script`,
    commands.includes(`scripts/ci/check-${lane}.sh`),
    commands,
  );
}

const referencedScripts = new Set();
for (const job of Object.values(jobs)) {
  for (const step of job.steps ?? []) {
    for (const match of String(step.run ?? '').matchAll(/(scripts\/ci\/[\w.-]+\.sh)/g)) {
      referencedScripts.add(match[1]);
    }
  }
}
for (const lane of LANES) {
  check(
    `CI invokes scripts/ci/check-${lane}.sh`,
    referencedScripts.has(`scripts/ci/check-${lane}.sh`),
    [...referencedScripts].join(', '),
  );
}
for (const script of referencedScripts) {
  check(`referenced script exists: ${script}`, existsSync(path.join(root, script)));
}

const staticScript = readFileSync(path.join(root, 'scripts', 'ci', 'check-static.sh'), 'utf8');
check('the static lane runs these tests', /node scripts\/ci\/ci-config\.test\.mjs/.test(staticScript));

// `src/`, `eval/`, and `firmware/` hold Python outside the robotd package. The
// static lane only parses them, so the robotd lane has to lint them or they
// lose static analysis entirely.
const robotdScript = readFileSync(path.join(root, 'scripts', 'ci', 'check-robotd.sh'), 'utf8');
check(
  'the robotd lane lints Python outside the package',
  /ruff check[^\n]*\.\.\/src[^\n]*\.\.\/eval[^\n]*\.\.\/firmware/.test(robotdScript),
  robotdScript,
);

// The integration lane backgrounds `robotd --sim`, so a failure is usually
// visible only in that process's log: `test:live` reports what the client saw.
// Without the trap dumping the log, a red integration lane in CI is opaque.
const integrationScript = readFileSync(path.join(root, 'scripts', 'ci', 'check-integration.sh'), 'utf8');
check(
  'the integration lane dumps the robotd log on failure',
  /cleanup\(\)[\s\S]*status=\$\?[\s\S]*cat "\$LOG_FILE"/.test(integrationScript),
  integrationScript,
);

// README promises that local `npm run gates` matches CI. Both entry points must
// call the same lane scripts, otherwise one side can silently drop a check.
// `apple` is the one deliberate exception: it needs Xcode and a macOS host, so
// `run-gates.sh` stays Linux-only rather than pretending to run it.
const gatesScript = readFileSync(path.join(root, 'scripts', 'ci', 'run-gates.sh'), 'utf8');
for (const lane of linuxLanes) {
  const script = `scripts/ci/check-${lane}.sh`;
  check(`run-gates.sh runs ${script}`, gatesScript.includes(`bash ${script}`));
}
check(
  'run-gates.sh stays Linux-only (the apple lane needs Xcode)',
  !gatesScript.includes('check-apple.sh'),
  gatesScript,
);

// The workflow decides *which* lane scripts run; the scripts decide *what*
// runs. A lane script that drops `set -euo pipefail` runs its failing suite and
// still exits 0 on the trailing `printf`, and a gutted script reports success
// without running anything. Both are silent greens the workflow tests cannot
// see, so pin strict mode and the command each lane exists to run.
const laneCommands = {
  static: [
    'scripts/ci/validate-baseline.sh',
    'npm run lint',
    'scripts/ci/ci-config.test.mjs',
    'npm run contract:check',
  ],
  robotd: ['ruff format', 'ruff check', 'python -m pytest'],
  agentd: ['npm --prefix agentd test'],
  integration: [
    'python3 -m unittest discover -s eval/voice/tests',
    '--sim',
    '/v1/health',
    'npm --prefix agentd run test:live',
  ],
  apple: ['swiftc -parse', 'swift test', 'eval/aec3/build_aec3.sh'],
};
const strictMode = /^set -euo pipefail$/m;
for (const [lane, commands] of Object.entries(laneCommands)) {
  const script = readFileSync(path.join(root, 'scripts', 'ci', `check-${lane}.sh`), 'utf8');
  check(`the ${lane} lane fails fast`, strictMode.test(script), script.slice(0, 200));
  for (const command of commands) {
    check(`the ${lane} lane runs "${command}"`, script.includes(command), script);
  }
}
check('run-gates.sh fails fast', strictMode.test(gatesScript), gatesScript.slice(0, 200));
check('run-gates.sh checks diff hygiene', /git diff --check/.test(gatesScript), gatesScript);

// GH-36: the apple lane exists so Swift is *compiled*. `|| true` (or a
// continue-on-error added later) would turn a compile failure back into a
// display-only check.
const appleScript = readFileSync(path.join(root, 'scripts', 'ci', 'check-apple.sh'), 'utf8');
check('the apple lane never masks a failure', !/\|\|\s*true\b/.test(appleScript), appleScript);
// `eval/aec3/build_aec3.sh` (GH-6) is fail-closed on its own: with no vendored
// sources it exits non-zero and points at `scripts/vendor-aec3.sh`. "The sources
// are not vendored yet" is not a defect, so the lane turns exactly that cause
// into a loud SKIP and stays red for every other failure. A silent skip, an
// unconditional `exit 0`, or dropping the vendor hint would each make the step
// unreadable when it really breaks.
check(
  'the apple lane keeps the AEC3 vendor hint',
  /vendor-aec3\.sh/.test(appleScript),
  appleScript,
);
check(
  'the apple lane records absent AEC3 sources as an explicit SKIP',
  appleScript.includes('SKIP: third_party/webrtc-aec3 empty'),
  appleScript,
);
check(
  'the apple lane skips AEC3 only when the sources are absent and build_aec3.sh said so',
  appleScript.includes('[ "$aec3_absent" = 1 ] && grep -q') &&
    appleScript.includes("grep -q 'vendor-aec3\\.sh'"),
  appleScript,
);
// `EnergyVAD` gives every stored property a default value, so Swift synthesises
// a *private* memberwise initializer and `@testable import` cannot reach it
// (that already produced one red lane). The extracted core must keep an explicit
// `init(speechDb: ...)`; without this assertion the diagnosis only shows up as a
// puzzling compile error in the XCTest step.
check(
  'the apple lane asserts the extracted core keeps an explicit EnergyVAD init',
  appleScript.includes("grep -q 'init(speechDb:'"),
  appleScript,
);

// README documents `npm run lint` and `npm run gates`, and the static lane
// calls `npm run lint` by name. Renaming a script in package.json would break
// the documented workflow, so pin the two entry points to the scripts they
// must run.
const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
check(
  'package.json exposes "lint" running the source lint gate',
  rootPackage.scripts?.lint === 'node scripts/ci/lint-sources.mjs',
  String(rootPackage.scripts?.lint),
);
check(
  'package.json exposes "gates" running run-gates.sh',
  rootPackage.scripts?.gates === 'bash scripts/ci/run-gates.sh',
  String(rootPackage.scripts?.gates),
);

console.log(failed === 0 ? '\nCI configuration tests passed' : `\n${failed} CI configuration test(s) failed`);
process.exit(failed === 0 ? 0 : 1);

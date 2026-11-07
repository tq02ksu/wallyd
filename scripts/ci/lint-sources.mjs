#!/usr/bin/env node
/**
 * Syntax gate for sources that no compiler checks.
 *
 * The TypeScript lane runs `tsc`, Python runs ruff, and generated contracts are
 * covered by `contract:check`. Everything else (Node scripts, shell scripts,
 * Python outside robotd, JSON fixtures, YAML contracts and workflows) had no
 * gate at all, so a typo in a maintenance script or a malformed workflow could
 * land on main unnoticed.
 *
 * This script is dependency-light on purpose: it only needs the repository's
 * existing `yaml` dependency plus the Node, Bash, and Python binaries already
 * available on CI runners and project machines.
 *
 * The checking logic is exported so `ci-config.test.mjs` can exercise it
 * without spawning child processes; the CLI entry point only adds the file
 * listing and the process exits.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const nodeExtensions = new Set(['.js', '.cjs', '.mjs']);
const yamlExtensions = new Set(['.yml', '.yaml']);

// `ast.parse` checks syntax without writing `__pycache__` into the worktree.
const pythonSyntaxCheck = 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())';

/** Map a tracked path to the syntax check it needs, or null when it has none. */
export function classifySource(rel) {
  const extension = path.extname(rel).toLowerCase();
  if (nodeExtensions.has(extension)) return 'node';
  if (extension === '.sh') return 'shell';
  if (extension === '.py') return 'python';
  if (extension === '.json') return 'json';
  if (yamlExtensions.has(extension)) return 'yaml';
  return null;
}

export function checkWorkflowShape(rel, document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return [`${rel}: workflow must be a mapping`];
  }
  const problems = [];
  // YAML 1.2 keeps an unquoted `on:` key as the string "on".
  if (document.on === undefined) problems.push(`${rel}: workflow has no trigger ("on")`);
  if (!document.jobs || typeof document.jobs !== 'object' || Array.isArray(document.jobs)) {
    problems.push(`${rel}: workflow has no jobs mapping`);
    return problems;
  }
  const jobs = Object.entries(document.jobs);
  if (jobs.length === 0) problems.push(`${rel}: workflow defines no jobs`);
  for (const [id, job] of jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      problems.push(`${rel}: job "${id}" must be a mapping`);
      continue;
    }
    if (job['runs-on'] === undefined && job.uses === undefined) {
      problems.push(`${rel}: job "${id}" has neither "runs-on" nor "uses"`);
    }
  }
  return problems;
}

/**
 * Run every applicable check.
 *
 * @param {object} options
 * @param {string} options.root repository root used to read JSON/YAML files
 * @param {string[]} options.files tracked paths relative to `root`
 * @param {(command: string, args: string[]) => string | null} options.run
 *   executes an external syntax check; returns an error message or null
 * @param {(file: string, encoding: string) => string} [options.readFile]
 * @returns {{counts: Record<string, number>, failures: string[]}}
 */
export function lintSources({ root, files, run, readFile = readFileSync }) {
  const counts = { node: 0, shell: 0, python: 0, json: 0, yaml: 0 };
  const failures = [];

  for (const rel of files) {
    const kind = classifySource(rel);
    if (!kind) continue;
    counts[kind] += 1;
    let error = null;

    if (kind === 'node') {
      error = run(process.execPath, ['--check', rel]);
    } else if (kind === 'shell') {
      error = run('bash', ['-n', rel]);
    } else if (kind === 'python') {
      error = run('python3', ['-c', pythonSyntaxCheck, rel]);
    } else if (kind === 'json') {
      try {
        JSON.parse(readFile(path.join(root, rel), 'utf8'));
      } catch (parseError) {
        error = parseError.message;
      }
    } else {
      try {
        const document = YAML.parse(readFile(path.join(root, rel), 'utf8'));
        if (rel.startsWith('.github/workflows/')) {
          const problems = checkWorkflowShape(rel, document);
          if (problems.length > 0) error = problems.join('\n');
        }
      } catch (parseError) {
        error = parseError.message;
      }
    }

    if (error) failures.push(`${rel}:\n${error}`);
  }

  return { counts, failures };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  function spawn(command, args) {
    return spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  }

  const listing = spawn('git', ['ls-files', '-z']);
  if (listing.status !== 0) {
    console.error(`Could not list tracked files: ${listing.stderr || listing.error?.message}`);
    process.exit(1);
  }
  const files = listing.stdout.split('\0').filter(Boolean);

  function run(command, args) {
    const result = spawn(command, args);
    if (result.status === 0) return null;
    const output = (result.stderr || result.error?.message || '').trim();
    return output || `${command} exited with status ${result.status ?? 'unknown'}`;
  }

  const { counts, failures } = lintSources({ root, files, run });

  if (failures.length > 0) {
    console.error(`Source lint failed (${failures.length} file(s)):`);
    for (const failure of failures) console.error(`\n${failure}`);
    process.exit(1);
  }

  console.log(
    `Source lint passed: ${counts.node} Node, ${counts.shell} shell, ${counts.python} Python, ${counts.json} JSON, ${counts.yaml} YAML`,
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}

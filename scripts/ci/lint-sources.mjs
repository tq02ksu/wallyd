#!/usr/bin/env node
/**
 * Syntax gate for sources that no compiler checks.
 *
 * The TypeScript lane runs `tsc`, Python runs ruff, and generated contracts are
 * covered by `contract:check`. Everything else (Node scripts, shell scripts,
 * JSON fixtures, YAML contracts and workflows) had no gate at all, so a typo in
 * a maintenance script or a malformed workflow could land on main unnoticed.
 *
 * This script is dependency-light on purpose: it only needs the repository's
 * existing `yaml` dependency and the Node/Bash binaries already required by the
 * project.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

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

const counts = { node: 0, shell: 0, json: 0, yaml: 0 };
const failures = [];
const nodeExtensions = new Set(['.js', '.cjs', '.mjs']);
const yamlExtensions = new Set(['.yml', '.yaml']);

function run(command, args) {
  const result = spawn(command, args);
  if (result.status === 0) return null;
  const output = (result.stderr || result.error?.message || '').trim();
  return output || `${command} exited with status ${result.status ?? 'unknown'}`;
}

function checkWorkflowShape(rel, document) {
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

for (const rel of files) {
  const extension = path.extname(rel).toLowerCase();
  let error = null;

  if (nodeExtensions.has(extension)) {
    counts.node += 1;
    error = run(process.execPath, ['--check', rel]);
  } else if (extension === '.sh') {
    counts.shell += 1;
    error = run('bash', ['-n', rel]);
  } else if (extension === '.json') {
    counts.json += 1;
    try {
      JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
    } catch (parseError) {
      error = parseError.message;
    }
  } else if (yamlExtensions.has(extension)) {
    counts.yaml += 1;
    try {
      const document = YAML.parse(readFileSync(path.join(root, rel), 'utf8'));
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

if (failures.length > 0) {
  console.error(`Source lint failed (${failures.length} file(s)):`);
  for (const failure of failures) console.error(`\n${failure}`);
  process.exit(1);
}

console.log(
  `Source lint passed: ${counts.node} Node, ${counts.shell} shell, ${counts.json} JSON, ${counts.yaml} YAML`,
);

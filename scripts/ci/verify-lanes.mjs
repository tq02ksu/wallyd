#!/usr/bin/env node
/**
 * Aggregate result gate for the required `quality` check.
 *
 * The `quality` job only exists to turn four lane results into one branch
 * protection status. Inline shell in the workflow did that, but no test could
 * reach it: a typo that turned the comparison into a no-op would leave the
 * required check green while a lane failed. Keeping the logic here makes it
 * an exported pure function that `ci-config.test.mjs` can call directly.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Lane job ids, in the order the aggregate check reports them. */
export const LANES = ['static', 'robotd', 'agentd', 'integration'];

/**
 * @param {Record<string, string | undefined>} results lane id -> GitHub job result
 * @returns {string[]} one message per lane that did not succeed
 */
export function verifyLaneResults(results) {
  const problems = [];
  for (const lane of LANES) {
    const result = results[lane];
    if (!result) {
      problems.push(`${lane}: no result`);
    } else if (result !== 'success') {
      problems.push(`${lane}: ${result}`);
    }
  }
  return problems;
}

function main() {
  const results = {};
  for (const lane of LANES) results[lane] = process.env[lane.toUpperCase()];

  for (const lane of LANES) console.log(`${lane}=${results[lane] ?? '<unset>'}`);

  const problems = verifyLaneResults(results);
  if (problems.length > 0) {
    console.error(`Quality gate failed:\n${problems.map((line) => `  ${line}`).join('\n')}`);
    process.exit(1);
  }
  console.log('All quality lanes succeeded');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}

#!/usr/bin/env node
// 校验文档没有「搬家后静默失效」，两条规则：
//   1. 所有 Markdown 相对链接都必须指向仓库里真实存在的文件（外链与页内锚点不管）
//   2. `docs/` 下每篇文档都必须登记进 `docs/index.md`（索引是唯一入口）
// 用法：npm run docs:check（`scripts/ci/run-gates.sh` 第 1 步也会跑）
//
// 只做静态文件检查：不发网络请求、不依赖 node_modules，因此离线可用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'docs', 'index.md');
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  'work',
]);
// [text](target) / ![alt](target)；允许目标后面跟一个 "title"
const LINK = /!?\[[^\]]*\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// 代码块里的示例链接不是真链接
function stripFences(text) {
  return text.replace(/^ {0,3}```[^\n]*\n[\s\S]*?^ {0,3}```[ \t]*$/gm, '');
}

function localTarget(raw) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return null;
  const stripped = raw.split('#')[0].split('?')[0];
  if (!stripped) return null;
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

function targetsOf(file) {
  const text = stripFences(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const match of text.matchAll(LINK)) {
    const target = localTarget(match[1]);
    if (target === null) continue;
    out.push(path.resolve(path.dirname(file), target));
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file);
const problems = [];
const files = walk(ROOT).sort();

for (const file of files) {
  const text = stripFences(fs.readFileSync(file, 'utf8'));
  for (const match of text.matchAll(LINK)) {
    const target = localTarget(match[1]);
    if (target === null) continue;
    if (!fs.existsSync(path.resolve(path.dirname(file), target))) {
      problems.push(`${rel(file)}: 链接目标不存在 → ${match[1]}`);
    }
  }
}

if (!fs.existsSync(INDEX)) {
  problems.push('docs/index.md 不存在');
} else {
  const registered = new Set(targetsOf(INDEX));
  for (const page of files) {
    if (!page.startsWith(path.join(ROOT, 'docs') + path.sep)) continue;
    if (path.resolve(page) === path.resolve(INDEX)) continue;
    if (!registered.has(path.resolve(page))) {
      problems.push(`${rel(page)}: 未登记到 docs/index.md`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`ERROR ${problem}`);
  console.error(`\n文档检查失败：${problems.length} 个问题`);
  process.exit(1);
}

console.log(`OK 文档检查通过（${files.length} 篇 Markdown，链接与索引登记一致）`);

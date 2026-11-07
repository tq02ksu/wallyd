#!/usr/bin/env node
// 跨端一致性测试用的小入口：stdin 收 {"cases":[{"args":{...},"approvalParams":[...]}]}，
// stdout 回 {"digests":["sha256:..."]}。不做其它事，避免测试依赖 agentd 运行时。
import fs from 'node:fs';
import { approvalArgsDigest } from './approval-digest.mjs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const cases = Array.isArray(input.cases) ? input.cases : [];
const digests = cases.map((item) =>
  approvalArgsDigest(item.args ?? {}, item.approvalParams ?? [], item.rules),
);
process.stdout.write(JSON.stringify({ digests }));

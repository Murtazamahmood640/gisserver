#!/usr/bin/env node
/**
 * checkLintBaseline.ts
 * CI ratchet: fails if any warning count in .eslint-baseline.json increases.
 * Usage: npx ts-node backend/scripts/checkLintBaseline.ts
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface LintMessage {
  ruleId: string | null;
  severity: number;
}
interface LintFile {
  messages: LintMessage[];
}

const baselinePath = path.resolve(__dirname, '../../.eslint-baseline.json');
if (!fs.existsSync(baselinePath)) {
  console.error('ERROR: .eslint-baseline.json not found at', baselinePath);
  process.exit(1);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Record<string, number>;

let reportJson: string;
try {
  const root = path.resolve(__dirname, '../..');
  reportJson = execSync('npx eslint . --format json', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e: unknown) {
  // eslint exits non-zero when there are problems; stdout still has JSON
  const err = e as { stdout?: string };
  reportJson = err.stdout || '';
}

if (!reportJson) {
  console.error('ERROR: Could not run eslint or get JSON output');
  process.exit(1);
}

const report: LintFile[] = JSON.parse(reportJson);
const current: Record<string, number> = {};

for (const file of report) {
  for (const msg of file.messages) {
    const rule = msg.ruleId || 'unknown';
    if (msg.severity === 1) {
      current[rule] = (current[rule] || 0) + 1;
    }
  }
}

let failed = false;
const allRules = new Set([...Object.keys(baseline), ...Object.keys(current)]);

for (const rule of allRules) {
  const base = baseline[rule] ?? 0;
  const now = current[rule] ?? 0;
  if (now > base) {
    console.error(`RATCHET FAIL [${rule}]: ${base} → ${now} (+${now - base})`);
    failed = true;
  } else if (now < base) {
    console.log(`RATCHET IMPROVED [${rule}]: ${base} → ${now} (-${base - now}) ← update baseline!`);
  } else {
    console.log(`OK [${rule}]: ${now}`);
  }
}

if (failed) {
  console.error('\nLint ratchet failed. Fix new warnings or update .eslint-baseline.json if intentional.');
  process.exit(1);
} else {
  console.log('\nLint ratchet passed.');
  process.exit(0);
}

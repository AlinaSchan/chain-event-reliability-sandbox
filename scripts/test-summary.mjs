// Turns a Vitest JSON report into a short Markdown summary (for $GITHUB_STEP_SUMMARY) and fails the
// job if anything failed OR was skipped: a skipped test is not a passed test, and CI must not show it as one.
//
// usage: node scripts/test-summary.mjs <report.json> [--allow-skipped]
import { readFileSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/test-summary.mjs <report.json> [--allow-skipped]');
  process.exit(2);
}
const allowSkipped = flags.includes('--allow-skipped');
const report = JSON.parse(readFileSync(file, 'utf8'));

const rows = [];
const totals = { passed: 0, failed: 0, skipped: 0 };
for (const suite of report.testResults ?? []) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const t of suite.assertionResults ?? []) {
    if (t.status === 'passed') counts.passed += 1;
    else if (t.status === 'failed') counts.failed += 1;
    else counts.skipped += 1; // pending / skipped / todo
  }
  totals.passed += counts.passed;
  totals.failed += counts.failed;
  totals.skipped += counts.skipped;
  rows.push({ name: String(suite.name).replace(/^.*[\\/](tests[\\/])/, '$1').replaceAll('\\', '/'), ...counts });
}

const lines = [];
lines.push('### Test summary');
lines.push('');
lines.push(`**${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped** across ${rows.length} files`);
lines.push('');
lines.push('| File | Passed | Failed | Skipped |');
lines.push('| --- | ---: | ---: | ---: |');
for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`| ${r.name} | ${r.passed} | ${r.failed} | ${r.skipped} |`);
}
console.log(lines.join('\n'));

if (totals.failed > 0) {
  console.error(`\n${totals.failed} test(s) failed`);
  process.exit(1);
}
if (totals.skipped > 0 && !allowSkipped) {
  console.error(`\n${totals.skipped} test(s) were skipped. A skipped test proves nothing; CI requires every test to run.`);
  process.exit(1);
}
if (totals.passed === 0) {
  console.error('\nno tests ran');
  process.exit(1);
}

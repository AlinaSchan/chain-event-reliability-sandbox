import { loadDotEnv } from '../src/app/config.js';
import { Db } from '../src/storage/db.js';
import { databaseUrl } from '../scenarios/harness.js';
import { findScenario, persistResult, runScenario, SCENARIOS } from '../scenarios/index.js';
import type { ScenarioResult } from '../scenarios/types.js';

/**
 * Runs the failure scenarios S01-S09 and prints one verdict per scenario.
 *
 *   npm run scenarios                      all scenarios
 *   npm run scenarios -- --only S04,S05    some of them
 *   npm run scenarios -- --json            machine-readable results
 *   npm run scenarios -- --allow-skipped   do not fail when a scenario was skipped (e.g. no Redis here)
 *   npm run scenarios -- --no-persist      do not store results where GET /scenarios/:id can show them
 *
 * Exit code: 1 if anything failed, or anything was skipped without --allow-skipped.
 */
loadDotEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const only = args.find((_arg, i) => args[i - 1] === '--only')?.split(',') ?? null;

const selected = only
  ? only.map((id) => {
      const def = findScenario(id);
      if (!def) {
        console.error(`unknown scenario ${id}; known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
        process.exit(2);
      }
      return def;
    })
  : [...SCENARIOS];

const results: ScenarioResult[] = [];
let db: Db | null = null;
if (!flag('--no-persist')) db = new Db({ connectionString: databaseUrl(), schema: process.env.DB_SCHEMA ?? 'public', max: 2 });

for (const def of selected) {
  const result = await runScenario(def);
  results.push(result);
  if (db && result.status !== 'skipped') {
    try {
      await persistResult(db, result);
    } catch (err) {
      console.error(`could not store the result of ${def.id} (run "npm run db:migrate" first?): ${(err as Error).message}`);
      db = null;
    }
  }
  if (!flag('--json')) printResult(result);
}
await db?.close();

if (flag('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const count = (s: ScenarioResult['status']) => results.filter((r) => r.status === s).length;
  console.log(`\n${results.length} scenario(s): ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`);
  if (count('skipped') > 0) console.log('A skipped scenario was NOT executed and proves nothing.');
}
const failed = results.some((r) => r.status === 'failed');
const skipped = results.some((r) => r.status === 'skipped');
process.exit(failed || (skipped && !flag('--allow-skipped')) ? 1 : 0);

function printResult(r: ScenarioResult): void {
  const verdict = r.status === 'passed' ? 'PASS' : r.status === 'failed' ? 'FAIL' : 'SKIP';
  console.log(`${r.id}  ${verdict}  ${r.title}  (${r.executedChecks}/${r.declaredChecks} checks, ${(r.durationMs / 1000).toFixed(1)}s)`);
  if (r.status === 'skipped') console.log(`      ${r.skipReason ?? ''}`);
  if (r.error) console.log(`      ${r.error}`);
  for (const c of r.checks.filter((x) => !x.passed)) {
    console.log(`      x ${c.id}: ${c.description}`);
    console.log(`          expected ${JSON.stringify(c.expected)}`);
    console.log(`          actual   ${JSON.stringify(c.actual)}`);
  }
}

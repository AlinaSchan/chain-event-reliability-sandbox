import { ConsoleNarrator } from '../scenarios/narrator.js';
import { findScenario, runScenario, SCENARIOS } from '../scenarios/index.js';

/**
 * Walks one failure scenario end to end, narrated:
 *   1 prepare the synthetic fixture   2 baseline ingestion   3 the canonical events it produced
 *   4 inject the fault                5 show what went wrong
 *   6 recover                         7 show the consistent end state and the verdict
 *
 *   npm run demo                      scenario S04 (chain reorganization)
 *   npm run demo -- --scenario S01    any of S01-S09 (S03 and S07 need Redis)
 *   npm run demo -- --list
 *
 * Everything shown is computed by the run: the verdict at the end is the scenario's own, with every
 * declared check evaluated against an independently derived expectation.
 */
const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const s of SCENARIOS) console.log(`${s.id}  ${s.title}${s.requires.includes('redis') ? '  (needs Redis)' : ''}`);
  process.exit(0);
}

const id = args.find((_arg, i) => args[i - 1] === '--scenario') ?? 'S04';
const def = findScenario(id);
if (!def) {
  console.error(`unknown scenario ${id}; try --list`);
  process.exit(2);
}

const rule = '='.repeat(78);
console.log(rule);
console.log(` Chain Event Reliability Sandbox - demo`);
console.log(` ${def.id}  ${def.title}`);
console.log(rule);
console.log(` ${def.summary}`);
console.log('');
console.log(` Fixture:    ${def.fixture}`);
console.log(` Faults:     ${def.faults.join(' | ')}`);
console.log(` Acceptance: ${def.acceptance}`);

const result = await runScenario(def, { narrator: new ConsoleNarrator() });

console.log('');
console.log(rule);
if (result.status === 'skipped') {
  console.log(` RESULT  SKIPPED  ${result.skipReason ?? ''}`);
  console.log(' A skipped scenario was not executed and proves nothing.');
} else {
  console.log(` RESULT  ${result.status === 'passed' ? 'PASS' : 'FAIL'}  ${def.id}  ${result.executedChecks}/${result.declaredChecks} declared checks evaluated, ${result.checks.filter((c) => c.passed).length} passed  (${(result.durationMs / 1000).toFixed(1)}s)`);
  for (const c of result.checks) console.log(`   [${c.passed ? ' OK ' : 'FAIL'}] ${c.id} - ${c.description}`);
  if (result.error) console.log(` ${result.error}`);
}
console.log(rule);
process.exit(result.status === 'passed' ? 0 : 1);

import { writeFileSync } from 'node:fs';
import { SCENARIOS } from '../scenarios/index.js';

/**
 * Renders docs/failure-scenarios.md from the scenario definitions themselves, so the document cannot
 * disagree with what the scenarios do (tests/unit/docs.test.ts fails if the committed file is stale).
 *
 *   npm run docs:scenarios
 */

/** Focused tests that exercise the same behavior, beyond the scenario itself. */
export const RELATED_TESTS: Record<string, string[]> = {
  S01: ['tests/unit/fixture.test.ts (a notifier that drops heads never replays them)', 'tests/integration/ingestion.test.ts (restart and incremental scans)'],
  S02: ['tests/fault-injection/duplicates.test.ts', 'tests/fault-injection/concurrent-workers.test.ts', 'tests/unit/prepare-retry.test.ts (duplicate logs in one response)'],
  S03: ['tests/integration/outbox.test.ts (against the in-process queue double)', 'tests/fault-injection/hard-kill.test.ts (a consumer process killed with SIGKILL)', 'tests/integration/queue-contract.test.ts (real Redis)'],
  S04: ['tests/integration/reorg.test.ts', 'tests/integration/outbox.test.ts (consumer/reorg interleaving)', 'tests/integration/api.test.ts (reorg visible through the API)'],
  S05: ['tests/fault-injection/rpc-faults.test.ts (including a 12-seed fault fuzzer)', 'tests/unit/prepare-retry.test.ts'],
  S06: ['tests/integration/confirmations.test.ts', 'tests/unit/watchlist-lifecycle.test.ts (the depth rule)'],
  S07: ['tests/integration/outbox.test.ts', 'tests/integration/queue-contract.test.ts', 'tests/fault-injection/hard-kill.test.ts'],
  S08: ['tests/integration/ingestion.test.ts (crash before and after COMMIT)', 'tests/fault-injection/hard-kill.test.ts (a scanner process killed with SIGKILL)', 'tests/integration/reorg.test.ts (crash during a reorg correction)'],
  S09: ['tests/fault-injection/thresholds.test.ts', 'tests/unit/units.test.ts', 'tests/unit/watchlist-lifecycle.test.ts'],
};

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join('\n');

export function renderScenarioDocs(): string {
  const out: string[] = [];
  out.push(`# Failure scenarios S01-S09

> Generated from \`scenarios/*.ts\` by \`npm run docs:scenarios\`. Edit the scenario definitions, not this file;
> \`tests/unit/docs.test.ts\` fails if this file is stale.

Every scenario below is executable. It builds a deterministic fixture in an isolated PostgreSQL schema,
injects its faults, and evaluates a list of **declared checks**, each comparing an observed value with an
expectation derived independently of the code under test (the fixture's own record of what it emitted, or a
constant written down in advance).

## How a verdict is reached

- **PASSED** requires all three: the scenario ran to the end without an exception, every check it evaluated
  passed, and every check it *declared* was evaluated. A scenario that skips a check by accident is reported as
  FAILED ("declared checks were never evaluated"), not passed.
- **SKIPPED** means the scenario could not run (S03 and S07 need a real Redis and \`REDIS_URL\`). Skipped is never
  reported as passed, \`npm run scenarios\` exits non-zero on it unless \`--allow-skipped\` is given, and CI fails on it.
- Each run's checks and evidence are stored in \`scenario_runs\` and served by \`GET /scenarios/:id\`.

## Running

\`\`\`bash
docker compose up -d --wait && npm run db:migrate   # PostgreSQL + Redis, schema
npm run scenarios                                   # all nine, one verdict per scenario
npm run scenarios -- --only S04,S05                 # some of them
npm run demo -- --scenario S04                      # one scenario, narrated step by step
npx vitest run tests/fault-injection/scenarios.test.ts   # the same nine, as tests
\`\`\`

## Summary

| ID | Scenario | Needs Redis | Reproduce | Declared checks |
| --- | --- | :---: | --- | ---: |`);
  for (const s of SCENARIOS) {
    out.push(`| ${s.id} | ${s.title} | ${s.requires.includes('redis') ? 'yes' : 'no'} | \`npm run scenarios -- --only ${s.id}\` | ${s.checks.length} |`);
  }

  for (const s of SCENARIOS) {
    out.push(`
## ${s.id} - ${s.title}

${s.summary}

**Acceptance criterion.** ${s.acceptance}

**Deterministic fixture.** ${s.fixture}

**Fault injection**

${bullets(s.faults)}

**Expected behavior**

${bullets(s.expected)}

**Observable evidence**

${bullets(s.evidence)}

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
${s.checks.map((c) => `| \`${c.id}\` | ${c.description} |`).join('\n')}

**Executable**

- \`npm run scenarios -- --only ${s.id}\` - verdict and failed checks with expected vs actual
- \`npm run demo -- --scenario ${s.id}\` - the same run, narrated${s.requires.includes('redis') ? '\n- needs `REDIS_URL` (see docker-compose.yml); without it this scenario is reported as skipped' : ''}
- \`npx vitest run tests/fault-injection/scenarios.test.ts -t "${s.id}"\`
- related focused tests: ${(RELATED_TESTS[s.id] ?? []).map((t) => `\`${t.split(' ')[0]}\`${t.includes(' (') ? ` ${t.slice(t.indexOf(' ('))}` : ''}`).join('; ')}`);
  }
  return `${out.join('\n')}\n`;
}

if (process.argv[1]?.endsWith('generate-scenario-docs.ts')) {
  writeFileSync(new URL('../docs/failure-scenarios.md', import.meta.url), renderScenarioDocs());
  console.log('wrote docs/failure-scenarios.md');
}

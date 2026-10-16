import { performance } from 'node:perf_hooks';
import type { Queryable } from '../src/storage/db.js';
import { ScenarioContext, toJson } from './context.js';
import { redisUrl, Sandbox } from './harness.js';
import type { Json, Narrator, ScenarioDefinition, ScenarioResult } from './types.js';

export interface RunOptions {
  narrator?: Narrator | null;
}

/**
 * Runs one scenario in its own PostgreSQL schema (and Redis key prefix) and returns the verdict.
 *
 * PASSED requires, all at once: the scenario ran to the end without throwing, every check it evaluated
 * passed, and every check it declared was in fact evaluated. A scenario that cannot run because a
 * dependency is missing is SKIPPED - it is never reported as passed.
 */
export async function runScenario(def: ScenarioDefinition, opts: RunOptions = {}): Promise<ScenarioResult> {
  const startedAt = new Date();
  const t0 = performance.now();
  const finish = (partial: Pick<ScenarioResult, 'status' | 'checks' | 'evidence'> & Partial<ScenarioResult>): ScenarioResult => ({
    id: def.id,
    title: def.title,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    declaredChecks: def.checks.length,
    executedChecks: new Set(partial.checks.map((c) => c.id)).size,
    ...partial,
  });

  if (def.requires.includes('redis') && redisUrl() === undefined) {
    return finish({
      status: 'skipped',
      skipReason: 'REDIS_URL is not set; this scenario needs a real Redis server (docker compose up -d --wait)',
      checks: [],
      evidence: {},
    });
  }

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create(def.sandbox);
    const ctx = new ScenarioContext(sandbox, def, opts.narrator ?? null);
    let error: string | undefined;
    try {
      await def.run(ctx);
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }

    const evaluated = new Set(ctx.checks.map((c) => c.id));
    const notExecuted = def.checks.filter((c) => !evaluated.has(c.id)).map((c) => c.id);
    const failed = ctx.checks.filter((c) => !c.passed).map((c) => c.id);
    ctx.record('logEvents', countEvents(sandbox));
    ctx.record('finalState', await sandbox.snapshot().catch(() => null));

    if (error === undefined && notExecuted.length > 0) error = `declared checks were never evaluated: ${notExecuted.join(', ')}`;
    if (error === undefined && failed.length > 0) error = `failed checks: ${[...new Set(failed)].join(', ')}`;
    return finish({ status: error === undefined ? 'passed' : 'failed', checks: ctx.checks, evidence: ctx.evidence, ...(error ? { error } : {}) });
  } catch (err) {
    return finish({ status: 'failed', checks: [], evidence: {}, error: `could not run: ${(err as Error).message}` });
  } finally {
    await sandbox?.destroy().catch(() => undefined);
  }
}

function countEvents(sandbox: Sandbox): Record<string, Json> {
  const counts: Record<string, number> = {};
  for (const line of sandbox.logs.lines) {
    if (typeof line.event === 'string') counts[line.event] = (counts[line.event] ?? 0) + 1;
  }
  return toJson(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))) as Record<string, Json>;
}

/** Stores a result where GET /scenarios/:id can find it. Requires the migrated schema of `db`. */
export async function persistResult(db: Queryable, result: ScenarioResult): Promise<void> {
  await db.query(
    `INSERT INTO scenario_runs (scenario_id, status, started_at, finished_at, duration_ms, checks, evidence, error, skip_reason)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      result.id,
      result.status,
      result.startedAt,
      result.finishedAt,
      result.durationMs,
      JSON.stringify(result.checks),
      JSON.stringify(result.evidence),
      result.error ?? null,
      result.skipReason ?? null,
    ],
  );
}

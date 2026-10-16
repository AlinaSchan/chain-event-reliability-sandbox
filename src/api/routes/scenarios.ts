import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../context.js';

interface RunRow {
  id: number;
  scenario_id: string;
  status: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  checks: Array<{ id: string; description: string; passed: boolean; expected: unknown; actual: unknown }>;
  evidence: Record<string, unknown>;
  error: string | null;
  skip_reason: string | null;
}

export function registerScenarioRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get(
    '/scenarios',
    {
      schema: {
        tags: ['scenarios'],
        summary: 'The failure scenarios S01-S09, with the verdict of the last recorded run of each',
        description: 'Runs are recorded by `npm run scenarios`. A scenario that has never been run, or was skipped, is reported as such - never as passed.',
        response: { 200: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
      },
    },
    async () => {
      const { rows } = await db.query<Pick<RunRow, 'scenario_id' | 'status' | 'finished_at' | 'duration_ms' | 'error' | 'skip_reason'>>(
        `SELECT DISTINCT ON (scenario_id) scenario_id, status, finished_at, duration_ms, error, skip_reason
           FROM scenario_runs ORDER BY scenario_id, id DESC`,
      );
      const last = new Map(rows.map((r) => [r.scenario_id, r]));
      return {
        items: ctx.scenarios.map((s) => {
          const run = last.get(s.id);
          return {
            id: s.id,
            title: s.title,
            summary: s.summary,
            acceptance: s.acceptance,
            requires: s.requires,
            declaredChecks: s.checks.length,
            lastRun: run
              ? { status: run.status, finishedAt: run.finished_at.toISOString(), durationMs: run.duration_ms, error: run.error, skipReason: run.skip_reason }
              : null,
          };
        }),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/scenarios/:id',
    {
      schema: {
        tags: ['scenarios'],
        summary: 'One scenario: fixture, injected faults, expected behavior, acceptance criterion, and the evidence of its last run',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^S0[1-9]$' } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: false, properties: { statusCode: { type: 'integer' }, error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const def = ctx.scenarios.find((s) => s.id === req.params.id);
      if (!def) return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `no scenario ${req.params.id}` });
      const { rows } = await db.query<RunRow>(
        `SELECT id, scenario_id, status, started_at, finished_at, duration_ms, checks, evidence, error, skip_reason
           FROM scenario_runs WHERE scenario_id = $1 ORDER BY id DESC LIMIT 10`,
        [def.id],
      );
      const latest = rows[0];
      return {
        ...def,
        lastRun: latest
          ? {
              status: latest.status,
              startedAt: latest.started_at.toISOString(),
              finishedAt: latest.finished_at.toISOString(),
              durationMs: latest.duration_ms,
              error: latest.error,
              skipReason: latest.skip_reason,
              checks: latest.checks,
              evidence: latest.evidence,
            }
          : null,
        history: rows.map((r) => ({ runId: r.id, status: r.status, finishedAt: r.finished_at.toISOString() })),
        note: latest ? undefined : 'This scenario has not been run against this database yet: npm run scenarios',
      };
    },
  );
}

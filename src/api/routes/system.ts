import type { FastifyInstance } from 'fastify';
import { COUNTER_HELP } from '../../observability/metrics.js';
import type { ApiContext } from '../context.js';
import { buildStatus } from '../status.js';

export function registerSystemRoutes(app: FastifyInstance, ctx: ApiContext): void {
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness and dependency reachability',
        description: 'Returns 200 when PostgreSQL answers, 503 otherwise. Redis being down is reported but does not make the process unhealthy: events and checkpoints do not depend on it.',
        response: {
          200: { type: 'object', additionalProperties: false, required: ['status', 'postgres', 'redis'], properties: { status: { type: 'string', enum: ['ok', 'degraded'] }, postgres: { type: 'string', enum: ['up'] }, redis: { type: 'string', enum: ['up', 'down', 'disabled'] } } },
          503: { type: 'object', additionalProperties: false, required: ['status', 'postgres', 'redis'], properties: { status: { type: 'string', enum: ['down'] }, postgres: { type: 'string', enum: ['down'] }, redis: { type: 'string', enum: ['up', 'down', 'disabled'] } } },
        },
      },
    },
    async (_req, reply) => {
      const redis = await redisState(ctx);
      try {
        await ctx.db.query('SELECT 1');
      } catch {
        return reply.code(503).send({ status: 'down', postgres: 'down', redis });
      }
      return { status: redis === 'down' ? 'degraded' : 'ok', postgres: 'up', redis };
    },
  );

  app.get<{ Querystring: { verify?: boolean } }>(
    '/status',
    {
      schema: {
        tags: ['system'],
        summary: 'Chain head, durable checkpoint, confirmation policy, counts, outbox and recovery state',
        description:
          'Everything needed to judge whether the service is keeping up and what it last had to repair. ' +
          '`?verify=true` additionally re-derives the stored-state invariants (reads every event; use it for checks, not for polling).',
        querystring: { type: 'object', additionalProperties: false, properties: { verify: { type: 'boolean', default: false } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (req) => buildStatus(ctx, { verify: req.query.verify === true }),
  );

  app.get(
    '/metrics',
    {
      schema: {
        tags: ['system'],
        summary: 'Prometheus text exposition',
        description: 'State gauges read from PostgreSQL plus counters of what this process has done. There is deliberately no uptime and no throughput metric.',
        response: { 200: { type: 'string' } },
      },
    },
    async (_req, reply) => {
      const status = await buildStatus(ctx, { verify: false });
      const chain = `chain_id="${ctx.chainId}"`;
      const lines: string[] = [];
      const gauge = (name: string, help: string, samples: Array<[string, number]>) => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
        for (const [labels, value] of samples) lines.push(`${name}{${labels}} ${value}`);
      };
      if (status.checkpoint) gauge('cers_checkpoint_block', 'Highest block whose data and events are committed', [[chain, status.checkpoint.lastBlockNumber]]);
      if ('number' in status.fixtureChainHead) gauge('cers_provider_head_block', 'Head block reported by the provider', [[chain, status.fixtureChainHead.number]]);
      if (status.lagBlocks !== null) gauge('cers_lag_blocks', 'Provider head minus checkpoint', [[chain, status.lagBlocks]]);
      gauge('cers_scanner_halted', '1 if the scanner halted and needs an operator', [[chain, status.checkpoint?.scanStatus === 'halted' ? 1 : 0]]);
      gauge(
        'cers_events',
        'Stored events by status',
        (['provisional', 'confirmed', 'orphaned'] as const).map((s) => [`${chain},status="${s}"`, status.events[s]] as [string, number]),
      );
      gauge(
        'cers_outbox_rows',
        'Outbox rows by status',
        (['pending', 'published', 'processed', 'suppressed'] as const).map((s) => [`${chain},status="${s}"`, status.outbox[s]] as [string, number]),
      );
      gauge('cers_incidents_open', 'Open incidents', [[chain, status.openIncidents.count]]);
      gauge('cers_incidents_requiring_manual_review', 'Open incidents that need a human', [[chain, status.openIncidents.requireManualReview]]);
      for (const [name, value] of Object.entries(ctx.metrics.snapshot())) {
        const help = COUNTER_HELP[name as keyof typeof COUNTER_HELP];
        lines.push(`# HELP cers_${name} ${help} (this process only)`, `# TYPE cers_${name} counter`, `cers_${name} ${value}`);
      }
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`);
    },
  );
}

async function redisState(ctx: ApiContext): Promise<'up' | 'down' | 'disabled'> {
  if (!ctx.queue) return 'disabled';
  try {
    await ctx.queue.length();
    return 'up';
  } catch {
    return 'down';
  }
}

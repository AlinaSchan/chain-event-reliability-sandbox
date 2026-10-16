import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext, FixtureControls } from '../context.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Operator and fault-injection routes. Registered only when ADMIN_ENABLED=true, on a loopback address,
 * with a token; every request must carry `Authorization: Bearer <ADMIN_TOKEN>`. They act on the
 * in-process fixture chain and on the scanner - there is no route that touches real funds, keys or
 * external systems, because this project has none.
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const controls = ctx.admin.controls as FixtureControls;
  const expected = sha256(ctx.admin.token ?? '');

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!timingSafeEqual(sha256(presented), expected)) {
      return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'admin routes need a valid bearer token' });
    }
    return undefined;
  };

  const base = { tags: ['admin'], security: [{ adminBearer: [] }] } as const;
  const ok = { 200: { type: 'object', additionalProperties: true } } as const;

  void app.register((admin, _opts, done) => {
    admin.addHook('onRequest', authenticate);

    admin.post<{ Body: { blocks: number } }>(
      '/admin/fixture/mine',
      { schema: { ...base, summary: 'Mine fixture blocks (seeded traffic)', body: { type: 'object', additionalProperties: false, required: ['blocks'], properties: { blocks: { type: 'integer', minimum: 1, maximum: 500 } } }, response: ok } },
      (req) => {
        const mined = controls.chain.mine(req.body.blocks);
        return { mined: mined.length, head: controls.chain.head };
      },
    );

    admin.post<{ Body: { depth: number; replacement: number; branch: string } }>(
      '/admin/fixture/reorg',
      {
        schema: {
          ...base,
          summary: 'Replace the last `depth` blocks with a competing branch of `replacement` blocks',
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['depth', 'replacement', 'branch'],
            properties: {
              depth: { type: 'integer', minimum: 1, maximum: 500 },
              replacement: { type: 'integer', minimum: 0, maximum: 500 },
              branch: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' },
            },
          },
          response: ok,
        },
      },
      (req, reply) => {
        try {
          const { ancestor, removed, added } = controls.chain.reorg(req.body);
          return { ancestor, removed: removed.length, added: added.length, head: controls.chain.head };
        } catch (err) {
          return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: (err as Error).message });
        }
      },
    );

    admin.post<{ Body: { action: 'disconnect' | 'reconnect' } }>(
      '/admin/fixture/notifier',
      { schema: { ...base, summary: 'Drop or restore the simulated WebSocket head-notification stream', body: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['disconnect', 'reconnect'] } } }, response: ok } },
      (req) => {
        if (req.body.action === 'disconnect') controls.notifier.disconnect();
        else controls.notifier.reconnect();
        return { connected: controls.notifier.connected, stats: controls.notifier.stats };
      },
    );

    admin.post<{ Body: { method: '*' | 'getHead' | 'getHeader' | 'getLogs'; action: 'timeout' | 'server_error' | 'stale' | 'duplicate_logs' | 'lagging'; times: number; skip?: number; lagBlocks?: number } }>(
      '/admin/fixture/faults',
      {
        schema: {
          ...base,
          summary: 'Schedule an RPC fault on the fixture provider (fires by call count)',
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['method', 'action', 'times'],
            properties: {
              method: { type: 'string', enum: ['*', 'getHead', 'getHeader', 'getLogs'] },
              action: { type: 'string', enum: ['timeout', 'server_error', 'stale', 'duplicate_logs', 'lagging'] },
              times: { type: 'integer', minimum: 1, maximum: 100000 },
              skip: { type: 'integer', minimum: 0, maximum: 100000 },
              lagBlocks: { type: 'integer', minimum: 1, maximum: 1000 },
            },
          },
          response: ok,
        },
      },
      (req) => {
        controls.provider.faults.add(req.body);
        return { scheduled: req.body, faultsRemaining: controls.provider.faults.remaining() };
      },
    );

    admin.delete('/admin/fixture/faults', { schema: { ...base, summary: 'Clear all scheduled provider faults', response: ok } }, () => {
      controls.provider.faults.clear();
      return { cleared: true };
    });

    admin.post('/admin/scanner/scan', { schema: { ...base, summary: 'Run one scan cycle now and return its report', response: ok } }, async () => controls.scanner.scanOnce('manual'));

    admin.post<{ Body: { note: string } }>(
      '/admin/scanner/unhalt',
      { schema: { ...base, summary: 'Clear a halt after the cause has been dealt with (resolves the halt incident, records the note)', body: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: { type: 'string', minLength: 8, maxLength: 500 } } }, response: ok } },
      async (req) => ({ cleared: await controls.scanner.unhalt(req.body.note) }),
    );

    done();
  });
}

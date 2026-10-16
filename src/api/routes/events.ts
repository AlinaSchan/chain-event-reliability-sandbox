import type { FastifyInstance } from 'fastify';
import type { Hex } from '../../domain/types.js';
import { formatUnits } from '../../domain/units.js';
import type { ApiContext } from '../context.js';

const EVENT_ID_PATTERN = '^[0-9]+:0x[0-9a-f]{64}:0x[0-9a-f]{64}:[0-9]+$';

interface EventRow {
  event_id: string;
  chain_id: number;
  block_hash: string;
  transaction_hash: string;
  log_index: number;
  block_number: number;
  contract_address: Hex;
  kind: string;
  decoded: Record<string, unknown>;
  amount: string;
  status: string;
  status_reason: string;
  confirm_count: number;
  seen_count: number;
  first_seen_at: Date;
  status_changed_at: Date;
  alert_status: string | null;
}

function present(ctx: ApiContext, r: EventRow) {
  const watch = ctx.watch.byAddress.get(r.contract_address);
  return {
    eventId: r.event_id,
    chainId: r.chain_id,
    status: r.status,
    statusReason: r.status_reason,
    kind: r.kind,
    contract: r.contract_address,
    symbol: watch?.symbol ?? null,
    blockNumber: r.block_number,
    blockHash: r.block_hash,
    transactionHash: r.transaction_hash,
    logIndex: r.log_index,
    amountUnits: r.amount,
    amount: watch ? formatUnits(BigInt(r.amount), watch.decimals) : null,
    decoded: r.decoded,
    alertStatus: r.alert_status,
    confirmCount: r.confirm_count,
    seenCount: r.seen_count,
    firstSeenAt: r.first_seen_at.toISOString(),
    statusChangedAt: r.status_changed_at.toISOString(),
  };
}

const eventSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['eventId', 'status', 'kind', 'blockNumber', 'amountUnits'],
  properties: {
    eventId: { type: 'string', description: '`chainId:blockHash:transactionHash:logIndex`' },
    status: { type: 'string', enum: ['provisional', 'confirmed', 'orphaned'] },
    statusReason: { type: 'string' },
    kind: { type: 'string', enum: ['erc20_transfer', 'settlement_recorded'] },
    contract: { type: 'string' },
    symbol: { type: ['string', 'null'] },
    blockNumber: { type: 'integer' },
    blockHash: { type: 'string' },
    transactionHash: { type: 'string' },
    logIndex: { type: 'integer' },
    amountUnits: { type: 'string', description: 'Exact amount in base units (decimal string).' },
    amount: { type: ['string', 'null'], description: 'The same amount in whole token units, exact.' },
    decoded: { type: 'object', additionalProperties: true },
    alertStatus: { type: ['string', 'null'], enum: ['open', 'withdrawn', null] },
    confirmCount: { type: 'integer' },
    seenCount: { type: 'integer', description: 'Sightings of this identity; more than 1 means it was delivered more than once.' },
  },
} as const;

export function registerEventRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, chainId } = ctx;

  app.get<{
    Querystring: { status?: string; kind?: string; fromBlock?: number; toBlock?: number; limit?: number; cursor?: string };
  }>(
    '/events',
    {
      schema: {
        tags: ['events'],
        summary: 'List events, newest first',
        description: '`status=canonical` means provisional or confirmed. Pagination is keyset-based: pass `nextCursor` back as `cursor`.',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['provisional', 'confirmed', 'orphaned', 'canonical'] },
            kind: { type: 'string', enum: ['erc20_transfer', 'settlement_recorded'] },
            fromBlock: { type: 'integer', minimum: 0 },
            toBlock: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            cursor: { type: 'string', maxLength: 300 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'nextCursor'],
            properties: { items: { type: 'array', items: eventSchema }, nextCursor: { type: ['string', 'null'] } },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query;
      const params: unknown[] = [chainId];
      const where: string[] = ['e.chain_id = $1'];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.status === 'canonical') where.push("e.status IN ('provisional', 'confirmed')");
      else if (q.status) add('e.status = ?', q.status);
      if (q.kind) add('e.kind = ?', q.kind);
      if (q.fromBlock !== undefined) add('e.block_number >= ?', q.fromBlock);
      if (q.toBlock !== undefined) add('e.block_number <= ?', q.toBlock);
      if (q.cursor) {
        let key: [number, number, string];
        try {
          key = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [number, number, string];
          if (!Array.isArray(key) || key.length !== 3 || typeof key[2] !== 'string') throw new Error('shape');
        } catch {
          return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'cursor is not valid' });
        }
        params.push(key[0], key[1], key[2]);
        where.push(`(e.block_number, e.log_index, e.event_id) < ($${params.length - 2}, $${params.length - 1}, $${params.length})`);
      }
      const limit = q.limit ?? 50;
      params.push(limit + 1);

      const { rows } = await db.query<EventRow>(
        `SELECT e.event_id, e.chain_id, e.block_hash, e.transaction_hash, e.log_index, e.block_number, e.contract_address,
                e.kind, e.decoded, e.amount::text AS amount, e.status, e.status_reason, e.confirm_count, e.seen_count,
                e.first_seen_at, e.status_changed_at, a.status AS alert_status
           FROM chain_events e LEFT JOIN alerts a ON a.event_id = e.event_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.block_number DESC, e.log_index DESC, e.event_id DESC
          LIMIT $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify([last.block_number, last.log_index, last.event_id])).toString('base64url') : null;
      return { items: page.map((r) => present(ctx, r)), nextCursor };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/events/:id',
    {
      schema: {
        tags: ['events'],
        summary: 'One event with its audit trail, notifications and deliveries',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: EVENT_ID_PATTERN } } },
        response: {
          200: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: false, properties: { statusCode: { type: 'integer' }, error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (req, reply) => {
      const { rows } = await db.query<EventRow>(
        `SELECT e.event_id, e.chain_id, e.block_hash, e.transaction_hash, e.log_index, e.block_number, e.contract_address,
                e.kind, e.decoded, e.amount::text AS amount, e.status, e.status_reason, e.confirm_count, e.seen_count,
                e.first_seen_at, e.status_changed_at, a.status AS alert_status
           FROM chain_events e LEFT JOIN alerts a ON a.event_id = e.event_id
          WHERE e.chain_id = $1 AND e.event_id = $2`,
        [chainId, req.params.id],
      );
      const row = rows[0];
      if (!row) return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: `no event ${req.params.id}` });

      const [audit, notifications, deliveries, blockRows] = await Promise.all([
        db.query<{ id: number; action: string; from_state: string | null; to_state: string | null; reason: string; details: unknown; created_at: Date }>(
          'SELECT id, action, from_state, to_state, reason, details, created_at FROM event_audit WHERE event_id = $1 ORDER BY id',
          [row.event_id],
        ),
        db.query<{ notification_id: string; notification_type: string; status: string; status_reason: string | null; publish_attempts: number; republish_count: number; duplicate_deliveries: number; last_error: string | null; created_at: Date; processed_at: Date | null }>(
          `SELECT notification_id, notification_type, status, status_reason, publish_attempts, republish_count, duplicate_deliveries, last_error, created_at, processed_at
             FROM outbox WHERE event_id = $1 ORDER BY id`,
          [row.event_id],
        ),
        db.query<{ notification_id: string; notification_type: string; event_status_at_delivery: string; delivered_at: Date }>(
          'SELECT notification_id, notification_type, event_status_at_delivery, delivered_at FROM notification_sink WHERE event_id = $1 ORDER BY delivered_at',
          [row.event_id],
        ),
        db.query<{ block_number: number; canonical: boolean; orphan_reason: string | null; parent_hash: string }>(
          'SELECT block_number, canonical, orphan_reason, parent_hash FROM chain_blocks WHERE chain_id = $1 AND block_hash = $2',
          [chainId, row.block_hash],
        ),
      ]);
      const block = blockRows.rows[0];
      return {
        ...present(ctx, row),
        block: block ? { number: block.block_number, canonical: block.canonical, parentHash: block.parent_hash, orphanReason: block.orphan_reason } : null,
        audit: audit.rows.map((a) => ({ id: a.id, action: a.action, from: a.from_state, to: a.to_state, reason: a.reason, details: a.details, at: a.created_at.toISOString() })),
        notifications: notifications.rows.map((n) => ({
          notificationId: n.notification_id,
          type: n.notification_type,
          status: n.status,
          statusReason: n.status_reason,
          publishAttempts: n.publish_attempts,
          republishCount: n.republish_count,
          duplicateDeliveries: n.duplicate_deliveries,
          lastError: n.last_error,
          createdAt: n.created_at.toISOString(),
          processedAt: n.processed_at?.toISOString() ?? null,
        })),
        deliveries: deliveries.rows.map((d) => ({ notificationId: d.notification_id, type: d.notification_type, eventStatusAtDelivery: d.event_status_at_delivery, deliveredAt: d.delivered_at.toISOString() })),
      };
    },
  );

  app.get<{ Querystring: { status?: string; limit?: number } }>(
    '/alerts',
    {
      schema: {
        tags: ['events'],
        summary: 'High-value alerts and the state of their notifications',
        description: 'An alert is open while its event is canonical and withdrawn once the event is orphaned. `notification` is the latest confirmation notification for the event, if any: alerts for provisional events have none.',
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['open', 'withdrawn'] }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
        response: { 200: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
      },
    },
    async (req) => {
      const params: unknown[] = [chainId];
      let statusFilter = '';
      if (req.query.status) {
        params.push(req.query.status);
        statusFilter = `AND a.status = $${params.length}`;
      }
      params.push(req.query.limit ?? 100);
      const { rows } = await db.query<{
        alert_id: string;
        event_id: string;
        status: string;
        status_reason: string;
        amount: string;
        threshold_units: string;
        contract_address: Hex;
        event_status: string;
        block_number: number;
        notification_status: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT a.alert_id, a.event_id, a.status, a.status_reason, a.amount::text AS amount, a.threshold_units::text AS threshold_units,
                a.contract_address, e.status AS event_status, e.block_number, a.created_at, a.updated_at,
                (SELECT o.status FROM outbox o WHERE o.event_id = a.event_id AND o.notification_type = 'event_confirmed' ORDER BY o.id DESC LIMIT 1) AS notification_status
           FROM alerts a JOIN chain_events e ON e.event_id = a.event_id
          WHERE a.chain_id = $1 ${statusFilter}
          ORDER BY e.block_number DESC, a.alert_id DESC
          LIMIT $${params.length}`,
        params,
      );
      return {
        items: rows.map((r) => {
          const watch = ctx.watch.byAddress.get(r.contract_address);
          return {
            alertId: r.alert_id,
            eventId: r.event_id,
            status: r.status,
            statusReason: r.status_reason,
            rule: 'high_value',
            symbol: watch?.symbol ?? null,
            amountUnits: r.amount,
            amount: watch ? formatUnits(BigInt(r.amount), watch.decimals) : null,
            thresholdUnits: r.threshold_units,
            threshold: watch ? formatUnits(BigInt(r.threshold_units), watch.decimals) : null,
            eventStatus: r.event_status,
            blockNumber: r.block_number,
            notification: r.notification_status,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
          };
        }),
      };
    },
  );
}

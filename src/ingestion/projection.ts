import type { Tx } from '../storage/db.js';

/**
 * Derived state: running inbound/outbound totals per (token, account) over non-orphaned ERC-20
 * transfers. It is only ever changed in the same transaction that changes the event it comes from,
 * and only for rows that transaction actually inserted, reactivated or orphaned. That is what keeps a
 * repeated delivery from counting twice.
 */
export class FlowDeltas {
  private readonly map = new Map<string, { token: string; account: string; inbound: bigint; outbound: bigint }>();

  addTransfer(token: string, from: string, to: string, value: bigint): void {
    this.bump(token, from, 0n, value);
    this.bump(token, to, value, 0n);
  }

  get size(): number {
    return this.map.size;
  }

  entries(): Array<{ token: string; account: string; inbound: bigint; outbound: bigint }> {
    return [...this.map.values()];
  }

  private bump(token: string, account: string, inbound: bigint, outbound: bigint): void {
    const key = `${token}|${account}`;
    const current = this.map.get(key) ?? { token, account, inbound: 0n, outbound: 0n };
    current.inbound += inbound;
    current.outbound += outbound;
    this.map.set(key, current);
  }
}

function columns(deltas: FlowDeltas) {
  const entries = deltas.entries();
  return [
    entries.map((e) => e.token),
    entries.map((e) => e.account),
    entries.map((e) => e.inbound.toString()),
    entries.map((e) => e.outbound.toString()),
  ];
}

export async function addFlows(tx: Tx, chainId: number, deltas: FlowDeltas): Promise<void> {
  if (deltas.size === 0) return;
  await tx.query(
    `INSERT INTO account_flows (chain_id, token_address, account, inbound, outbound)
     SELECT $1::bigint, t.token, t.account, t.inbound::numeric, t.outbound::numeric
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(token, account, inbound, outbound)
     ON CONFLICT (chain_id, token_address, account) DO UPDATE
        SET inbound = account_flows.inbound + EXCLUDED.inbound,
            outbound = account_flows.outbound + EXCLUDED.outbound,
            updated_at = now()`,
    [chainId, ...columns(deltas)],
  );
}

/**
 * Reverses earlier contributions. A plain UPDATE (not an upsert) on purpose: every row being reversed
 * must already exist, and the table's non-negative CHECK turns a double reversal into a failed
 * transaction rather than a silently wrong total.
 */
export async function subtractFlows(tx: Tx, chainId: number, deltas: FlowDeltas): Promise<void> {
  if (deltas.size === 0) return;
  const res = await tx.query(
    `UPDATE account_flows f
        SET inbound = f.inbound - t.inbound::numeric,
            outbound = f.outbound - t.outbound::numeric,
            updated_at = now()
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(token, account, inbound, outbound)
      WHERE f.chain_id = $1 AND f.token_address = t.token AND f.account = t.account`,
    [chainId, ...columns(deltas)],
  );
  if ((res.rowCount ?? 0) !== deltas.size) {
    throw new Error(`projection corrupt: reversing ${deltas.size} totals touched ${res.rowCount ?? 0} rows`);
  }
}

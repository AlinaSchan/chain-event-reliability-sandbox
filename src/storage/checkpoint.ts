import type { Hex } from '../domain/types.js';
import type { Queryable, Tx } from './db.js';

export type ScanStatus = 'ok' | 'degraded' | 'halted';

export interface Checkpoint {
  chainId: number;
  startBlock: number;
  lastBlockNumber: number;
  lastBlockHash: Hex | null;
  scanStatus: ScanStatus;
  statusDetail: Record<string, unknown> | null;
  version: number;
  updatedAt: Date;
}

interface Row {
  chain_id: number;
  start_block: number;
  last_block_number: number;
  last_block_hash: string | null;
  scan_status: ScanStatus;
  status_detail: Record<string, unknown> | null;
  version: number;
  updated_at: Date;
}

const toCheckpoint = (r: Row): Checkpoint => ({
  chainId: r.chain_id,
  startBlock: r.start_block,
  lastBlockNumber: r.last_block_number,
  lastBlockHash: r.last_block_hash as Hex | null,
  scanStatus: r.scan_status,
  statusDetail: r.status_detail,
  version: r.version,
  updatedAt: r.updated_at,
});

/** Creates the checkpoint row at `startBlock - 1` (nothing ingested) if it does not exist. */
export async function ensureCheckpoint(db: Queryable, chainId: number, startBlock: number): Promise<Checkpoint> {
  await db.query(
    `INSERT INTO scanner_checkpoints (chain_id, start_block, last_block_number, last_block_hash)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (chain_id) DO NOTHING`,
    [chainId, startBlock, startBlock - 1],
  );
  const cp = await getCheckpoint(db, chainId);
  if (!cp) throw new Error(`checkpoint for chain ${chainId} vanished`);
  return cp;
}

export async function getCheckpoint(db: Queryable, chainId: number): Promise<Checkpoint | null> {
  const { rows } = await db.query<Row>('SELECT * FROM scanner_checkpoints WHERE chain_id = $1', [chainId]);
  return rows[0] ? toCheckpoint(rows[0]) : null;
}

/**
 * Takes the per-chain writer lock for the rest of the transaction. This row lock is what makes the
 * single-writer rule safe even if two worker processes are running: the second one waits here, then
 * sees a newer `version` and must start over from the stored state.
 */
export async function lockCheckpoint(tx: Tx, chainId: number): Promise<Checkpoint> {
  const { rows } = await tx.query<Row>('SELECT * FROM scanner_checkpoints WHERE chain_id = $1 FOR UPDATE', [chainId]);
  if (!rows[0]) throw new Error(`no checkpoint for chain ${chainId}`);
  return toCheckpoint(rows[0]);
}

/** Moves the tip. Always bumps `version`. Must be called with the lock held. */
export async function advanceCheckpoint(tx: Tx, chainId: number, lastBlockNumber: number, lastBlockHash: Hex | null): Promise<void> {
  await tx.query(
    `UPDATE scanner_checkpoints
        SET last_block_number = $2, last_block_hash = $3, scan_status = 'ok', status_detail = NULL,
            version = version + 1, updated_at = now()
      WHERE chain_id = $1`,
    [chainId, lastBlockNumber, lastBlockHash],
  );
}

/**
 * ok <-> degraded. Status-only: does not touch the tip and does not bump `version`.
 * Never overwrites `halted`; only haltCheckpoint / unhaltCheckpoint change that.
 */
export async function setHealth(
  db: Queryable,
  chainId: number,
  status: 'ok' | 'degraded',
  detail: Record<string, unknown> | null,
): Promise<void> {
  await db.query(
    `UPDATE scanner_checkpoints
        SET scan_status = $2, status_detail = $3::jsonb, updated_at = now()
      WHERE chain_id = $1 AND scan_status <> 'halted'`,
    [chainId, status, detail === null ? null : JSON.stringify(detail)],
  );
}

/** Stops all further writes for the chain until an operator clears it. */
export async function haltCheckpoint(tx: Tx, chainId: number, detail: Record<string, unknown>): Promise<void> {
  await tx.query(
    `UPDATE scanner_checkpoints SET scan_status = 'halted', status_detail = $2::jsonb, updated_at = now() WHERE chain_id = $1`,
    [chainId, JSON.stringify(detail)],
  );
}

/** Returns false if the chain was not halted. */
export async function unhaltCheckpoint(tx: Tx, chainId: number): Promise<boolean> {
  const res = await tx.query(
    `UPDATE scanner_checkpoints SET scan_status = 'ok', status_detail = NULL, updated_at = now()
      WHERE chain_id = $1 AND scan_status = 'halted'`,
    [chainId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Thrown when another writer moved the tip between our read and our commit. The caller starts over. */
export class StaleCheckpointError extends Error {
  override readonly name = 'StaleCheckpointError';
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`checkpoint moved: expected version ${expectedVersion}, found ${actualVersion}`);
  }
}

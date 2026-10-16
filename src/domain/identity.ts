import type { Hex } from './types.js';

/**
 * Identity of one EVM contract log occurrence.
 *
 * The block hash is part of the key on purpose. The same transaction can be re-included in a
 * different block after a reorganization; that is a new occurrence (new block hash) and the old one
 * stays in the table as an orphaned row for audit. Re-delivery of the *same* occurrence always
 * produces the same key.
 */
export interface EventIdentity {
  chainId: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

export function eventIdOf(identity: EventIdentity): string {
  const { chainId, blockHash, transactionHash, logIndex } = identity;
  return `${chainId}:${blockHash.toLowerCase()}:${transactionHash.toLowerCase()}:${logIndex}`;
}

export function parseEventId(id: string): EventIdentity {
  const match = /^(\d+):(0x[0-9a-f]{64}):(0x[0-9a-f]{64}):(\d+)$/.exec(id);
  if (!match) throw new Error(`malformed event id: ${id}`);
  return {
    chainId: Number(match[1]),
    blockHash: match[2] as Hex,
    transactionHash: match[3] as Hex,
    logIndex: Number(match[4]),
  };
}

export type NotificationType = 'event_confirmed' | 'event_retracted';

/**
 * Identity of one downstream notification. It is derived from, but deliberately distinct from, the
 * event identity: one event can produce several notifications over its life (confirmed, then
 * retracted, then confirmed again after a re-canonicalization). `epoch` is the event's confirmation
 * counter at the time, so every logical notification has exactly one id.
 */
export function notificationIdOf(eventId: string, type: NotificationType, epoch: number): string {
  return `${eventId}#${type}#${epoch}`;
}

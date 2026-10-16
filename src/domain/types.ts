/** Shared vocabulary. Everything here is plain data so it can cross the RPC, database and queue boundaries. */

export type Hex = `0x${string}`;

export const ZERO_HASH: Hex = `0x${'0'.repeat(64)}`;

export type EventKind = 'erc20_transfer' | 'settlement_recorded';

/** States an event can have once it is durable. */
export type EventStatus = 'provisional' | 'confirmed' | 'orphaned';

/**
 * `observed` is the decode-time state: an event that has been read from the provider but not yet
 * committed. It is never stored on its own (see docs/event-lifecycle.md); the audit trail records it
 * as the `from` side of the first transition.
 */
export type LifecycleState = 'observed' | EventStatus;

export interface HeadRef {
  number: number;
  hash: Hex;
}

/** What `eth_getBlockByNumber(n, false)` would give us, reduced to the fields the scanner needs. */
export interface BlockHeader {
  chainId: number;
  number: number;
  hash: Hex;
  parentHash: Hex;
  /** Unix seconds. */
  timestamp: number;
  transactionHashes: Hex[];
}

/** What `eth_getLogs` returns for one log. */
export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockHash: Hex;
  blockNumber: number;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

export type ScanTrigger = 'startup' | 'notification' | 'reconnect' | 'poll' | 'manual';

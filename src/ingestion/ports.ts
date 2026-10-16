import type { BlockHeader, HeadRef, Hex, RpcLog } from '../domain/types.js';

/**
 * The only way the scanner sees a chain. The surface mirrors the three JSON-RPC reads it needs
 * (head number + hash, `eth_getBlockByNumber`, `eth_getLogs`). The sandbox ships one implementation,
 * the deterministic fixture in src/fixtures; a read-only RPC adapter would implement this same interface.
 */
export interface ChainProvider {
  readonly chainId: number;
  getHead(): Promise<HeadRef>;
  /** Canonical header at `number` as this provider currently sees it, or null if it has none. */
  getHeader(number: number): Promise<BlockHeader | null>;
  getLogs(range: { fromBlock: number; toBlock: number; addresses: readonly Hex[] }): Promise<RpcLog[]>;
}

export interface HeadSubscriber {
  onHead(head: HeadRef): void;
  onConnect(): void;
  onDisconnect(): void;
}

/**
 * Stand-in for a WebSocket `newHeads` subscription. It is only ever a hint that the head may have
 * moved: it carries no events, it is not replayed after a disconnect, and nothing relies on it for
 * correctness. The scanner derives progress from stored state and block ranges.
 */
export interface HeadNotifier {
  subscribe(subscriber: HeadSubscriber): () => void;
}

import { RpcError } from '../domain/errors.js';
import type { BlockHeader, HeadRef, Hex, RpcLog } from '../domain/types.js';
import type { ChainProvider } from '../ingestion/ports.js';
import type { FixtureChain } from './chain.js';
import { FaultPlan, type RpcMethod } from './faults.js';

/** Serves a `FixtureChain`, with deterministic fault injection layered on top. */
export class FixtureProvider implements ChainProvider {
  readonly faults = new FaultPlan();
  readonly calls: Record<RpcMethod, number> = { getHead: 0, getHeader: 0, getLogs: 0 };
  private readonly lastResponse = new Map<string, unknown>();

  constructor(private readonly chain: FixtureChain) {}

  get chainId(): number {
    return this.chain.chainId;
  }

  getHead(): Promise<HeadRef> {
    return this.call(
      'getHead',
      '',
      () => this.chain.head,
      (lag) => {
        const number = Math.max(0, this.chain.head.number - lag);
        const header = this.chain.getHeaderByNumber(number);
        return header ? { number, hash: header.hash } : this.chain.head;
      },
    );
  }

  getHeader(number: number): Promise<BlockHeader | null> {
    return this.call('getHeader', String(number), () => this.chain.getHeaderByNumber(number));
  }

  getLogs(range: { fromBlock: number; toBlock: number; addresses: readonly Hex[] }): Promise<RpcLog[]> {
    return this.call('getLogs', `${range.fromBlock}-${range.toBlock}`, () =>
      this.chain.logsInRange(range.fromBlock, range.toBlock, range.addresses),
    );
  }

  private call<T>(method: RpcMethod, key: string, produce: () => T, lagging?: (lagBlocks: number) => T): Promise<T> {
    this.calls[method] += 1;
    const cacheKey = `${method}:${key}`;
    const fault = this.faults.take(method);
    switch (fault?.action) {
      case 'timeout':
        return Promise.reject(new RpcError('TIMEOUT', `${method} timed out (injected)`));
      case 'server_error':
        return Promise.reject(new RpcError('SERVER_ERROR', `${method} returned 503 (injected)`));
      case 'stale': {
        if (this.lastResponse.has(cacheKey)) return Promise.resolve(this.lastResponse.get(cacheKey) as T);
        break;
      }
      case 'duplicate_logs': {
        const fresh = produce();
        if (Array.isArray(fresh)) return Promise.resolve([...fresh, ...fresh] as T);
        break;
      }
      case 'lagging':
        if (lagging) return Promise.resolve(lagging(fault?.lagBlocks ?? 1));
        break;
      case undefined:
        break;
    }
    const value = produce();
    this.lastResponse.set(cacheKey, value);
    return Promise.resolve(value);
  }
}

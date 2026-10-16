import { concatHex, encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from 'viem';
import { encodeSettlementLog, encodeTransferLog } from '../domain/abi.js';
import { eventIdOf } from '../domain/identity.js';
import type { BlockHeader, EventKind, HeadRef, Hex, RpcLog } from '../domain/types.js';
import { ZERO_HASH } from '../domain/types.js';
import { isHighValue } from '../domain/units.js';
import type { ResolvedWatch, WatchIndex } from '../domain/watchlist.js';
import { ACCOUNT_LABELS, resolveAccount, syntheticAddress } from './accounts.js';
import { mulberry32, randBelow, seedFrom } from './prng.js';

/**
 * A deterministic, in-memory EVM-shaped chain. It can mine blocks, replace the tip with a competing
 * branch, and switch back to a previously known branch. Every block it ever produced stays
 * addressable by hash, so tests can inspect the branch that was abandoned.
 *
 * Nothing here is a real network: no signing, no keys, no value. Addresses come from
 * `syntheticAddress` and transaction hashes are hashes of labels.
 */

/** What a log *means*, recorded by the fixture itself so tests have an oracle that does not use the decoder. */
export type LogMeta =
  | { kind: 'erc20_transfer'; from: Hex; to: Hex; value: bigint }
  | { kind: 'settlement_recorded'; settlementId: Hex; beneficiary: Hex; amount: bigint; status: number }
  | { kind: 'raw'; expected: 'ignored' | 'undecodable' };

export interface LogTemplate {
  address: Hex;
  topics: Hex[];
  data: Hex;
  meta: LogMeta;
}

export interface TxTemplate {
  hash: Hex;
  from: Hex;
  to: Hex;
  logs: LogTemplate[];
}

export interface StoredBlock {
  header: BlockHeader;
  branch: string;
  txs: readonly TxTemplate[];
  logs: readonly RpcLog[];
  /** meta[i] describes logs[i]. */
  meta: readonly LogMeta[];
}

export type ScriptedLog =
  | { kind: 'erc20_transfer'; token: string; from: string; to: string; value: bigint }
  | { kind: 'settlement_recorded'; contract: string; beneficiary: string; amount: bigint; status?: number; settlementId?: Hex }
  | { kind: 'raw'; address: Hex; topics: Hex[]; data: Hex; expected: 'ignored' | 'undecodable' };

export interface ScriptedTx {
  /** A labeled transaction has the same hash on every branch, which models re-inclusion after a reorg. */
  label?: string;
  from?: string;
  logs: ScriptedLog[];
}

export interface BlockSpec {
  txs?: ScriptedTx[];
  /** Set false to suppress background traffic for this block. */
  random?: boolean;
}

export interface ReorgOptions {
  /** Blocks removed from the canonical tip. */
  depth: number;
  /** Blocks mined on the common ancestor to replace them (may be more or fewer than `depth`). */
  replacement: number;
  branch: string;
  specs?: ReadonlyArray<BlockSpec | undefined>;
  /** 'all': replacement block i re-includes the transactions of removed block i with their original hashes. */
  reinclude?: 'none' | 'all';
}

export interface ReorgResult {
  ancestor: HeadRef;
  removed: StoredBlock[];
  added: StoredBlock[];
}

export interface ExpectedEvent {
  eventId: string;
  chainId: number;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  kind: EventKind;
  contract: Hex;
  amount: bigint;
  meta: Exclude<LogMeta, { kind: 'raw' }>;
  highValue: boolean;
}

export interface FixtureChainOptions {
  chainId: number;
  seed: string;
  watch: WatchIndex;
  genesisTimestamp?: number;
  blockTimeSeconds?: number;
  /** 'random' adds seeded background traffic to every block; 'scripted' emits only what callers ask for. */
  traffic?: 'random' | 'scripted';
}

const HEADER_PARAMS = parseAbiParameters('uint256, uint256, bytes32, uint256, bytes32, bytes32');

export class FixtureChain {
  readonly chainId: number;
  readonly seed: string;
  private readonly watch: WatchIndex;
  private readonly traffic: 'random' | 'scripted';
  private readonly genesisTimestamp: number;
  private readonly blockTimeSeconds: number;
  private readonly known = new Map<Hex, StoredBlock>();
  private canonical: StoredBlock[] = [];
  private readonly listeners = new Set<(head: HeadRef) => void>();

  constructor(opts: FixtureChainOptions) {
    this.chainId = opts.chainId;
    this.seed = opts.seed;
    this.watch = opts.watch;
    this.traffic = opts.traffic ?? 'random';
    this.genesisTimestamp = opts.genesisTimestamp ?? 1_700_000_000;
    this.blockTimeSeconds = opts.blockTimeSeconds ?? 12;
    const genesis = this.assemble(undefined, 'main', []);
    this.known.set(genesis.header.hash, genesis);
    this.canonical = [genesis];
  }

  // ---- Reading -------------------------------------------------------------------------------

  get head(): HeadRef {
    const tip = this.tip();
    return { number: tip.header.number, hash: tip.header.hash };
  }

  tip(): StoredBlock {
    const tip = this.canonical[this.canonical.length - 1];
    if (!tip) throw new Error('fixture chain has no blocks');
    return tip;
  }

  blockAt(number: number): StoredBlock | undefined {
    return this.canonical[number];
  }

  blockByHash(hash: Hex): StoredBlock | undefined {
    return this.known.get(hash.toLowerCase() as Hex);
  }

  getHeaderByNumber(number: number): BlockHeader | null {
    return this.canonical[number]?.header ?? null;
  }

  logsInRange(fromBlock: number, toBlock: number, addresses?: readonly Hex[]): RpcLog[] {
    const wanted = addresses ? new Set(addresses.map((a) => a.toLowerCase())) : undefined;
    const out: RpcLog[] = [];
    for (let n = Math.max(0, fromBlock); n <= Math.min(toBlock, this.head.number); n++) {
      for (const log of this.canonical[n]?.logs ?? []) {
        if (!wanted || wanted.has(log.address.toLowerCase())) out.push(log);
      }
    }
    return out;
  }

  onHead(listener: (head: HeadRef) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The ground truth: every watched event in the given blocks (default: the current canonical chain). */
  expectedEvents(blocks: readonly StoredBlock[] = this.canonical): ExpectedEvent[] {
    const out: ExpectedEvent[] = [];
    for (const block of blocks) {
      block.logs.forEach((log, i) => {
        const meta = block.meta[i];
        if (!meta || meta.kind === 'raw') return;
        const watch = this.watch.byAddress.get(log.address.toLowerCase() as Hex);
        if (!watch) return;
        const amount = meta.kind === 'erc20_transfer' ? meta.value : meta.amount;
        out.push({
          eventId: eventIdOf({ chainId: this.chainId, blockHash: log.blockHash, transactionHash: log.transactionHash, logIndex: log.logIndex }),
          chainId: this.chainId,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          kind: meta.kind,
          contract: log.address,
          amount,
          meta,
          highValue: isHighValue(amount, watch.thresholdUnits),
        });
      });
    }
    return out;
  }

  // ---- Changing the chain -----------------------------------------------------------------------

  /** Mines `count` blocks on the current tip. `specs[i]` scripts block i; unscripted blocks get seeded traffic. */
  mine(count = 1, specs: ReadonlyArray<BlockSpec | undefined> = [], opts: { branch?: string } = {}): StoredBlock[] {
    const out: StoredBlock[] = [];
    for (let i = 0; i < count; i++) {
      const parent = this.tip();
      const block = this.buildBlock(parent, opts.branch ?? parent.branch, specs[i], []);
      this.append(block);
      out.push(block);
      this.emitHead(block);
    }
    return out;
  }

  mineOne(spec?: BlockSpec): StoredBlock {
    const [block] = this.mine(1, [spec]);
    if (!block) throw new Error('mine produced no block');
    return block;
  }

  /** Replaces the last `depth` blocks with a competing branch built on their common ancestor. */
  reorg(opts: ReorgOptions): ReorgResult {
    if (opts.depth < 1 || opts.depth > this.canonical.length - 1) {
      throw new Error(`reorg depth ${opts.depth} out of range for a chain with head ${this.head.number}`);
    }
    const removed = this.canonical.splice(this.canonical.length - opts.depth, opts.depth);
    const ancestor = this.tip();
    const added: StoredBlock[] = [];
    for (let i = 0; i < opts.replacement; i++) {
      const parent = this.tip();
      const carried = opts.reinclude === 'all' ? [...(removed[i]?.txs ?? [])] : [];
      const block = this.buildBlock(parent, opts.branch, opts.specs?.[i], carried);
      this.append(block);
      added.push(block);
      this.emitHead(block);
    }
    if (opts.replacement === 0) this.emitHead(ancestor);
    return { ancestor: { number: ancestor.header.number, hash: ancestor.header.hash }, removed, added };
  }

  /** Makes the branch ending at `tipHash` canonical again (every ancestor must be a known block). */
  setCanonicalTip(tipHash: Hex): void {
    const chain: StoredBlock[] = [];
    let cursor = this.known.get(tipHash.toLowerCase() as Hex);
    while (cursor) {
      chain.push(cursor);
      if (cursor.header.number === 0) break;
      cursor = this.known.get(cursor.header.parentHash);
    }
    const genesis = chain[chain.length - 1];
    if (!genesis || genesis.header.number !== 0) throw new Error(`unknown or disconnected tip ${tipHash}`);
    this.canonical = chain.reverse();
    this.emitHead(this.tip());
  }

  // ---- Construction -----------------------------------------------------------------------------

  private append(block: StoredBlock): void {
    this.known.set(block.header.hash, block);
    this.canonical.push(block);
  }

  private emitHead(block: StoredBlock): void {
    const head: HeadRef = { number: block.header.number, hash: block.header.hash };
    for (const listener of this.listeners) listener(head);
  }

  private buildBlock(parent: StoredBlock, branch: string, spec: BlockSpec | undefined, carried: TxTemplate[]): StoredBlock {
    const number = parent.header.number + 1;
    const txs: TxTemplate[] = [...carried];
    (spec?.txs ?? []).forEach((scripted, i) => txs.push(this.scriptedTx(scripted, number, branch, i)));
    if (this.traffic === 'random' && spec?.random !== false) {
      txs.push(...this.randomTxs(number, branch, parent.header.hash));
    }
    return this.assemble(parent, branch, txs);
  }

  private assemble(parent: StoredBlock | undefined, branch: string, txs: TxTemplate[]): StoredBlock {
    const number = parent ? parent.header.number + 1 : 0;
    const parentHash = parent ? parent.header.hash : ZERO_HASH;
    const timestamp = this.genesisTimestamp + number * this.blockTimeSeconds;
    const txRoot = txs.length > 0 ? keccak256(concatHex(txs.map((t) => t.hash))) : ZERO_HASH;
    const hash = keccak256(
      encodeAbiParameters(HEADER_PARAMS, [
        BigInt(this.chainId),
        BigInt(number),
        parentHash,
        BigInt(timestamp),
        txRoot,
        keccak256(stringToHex(branch)),
      ]),
    ).toLowerCase() as Hex;

    const logs: RpcLog[] = [];
    const meta: LogMeta[] = [];
    txs.forEach((tx, transactionIndex) => {
      for (const template of tx.logs) {
        logs.push({
          address: template.address,
          topics: template.topics,
          data: template.data,
          blockHash: hash,
          blockNumber: number,
          transactionHash: tx.hash,
          transactionIndex,
          logIndex: logs.length,
        });
        meta.push(template.meta);
      }
    });

    return {
      header: { chainId: this.chainId, number, hash, parentHash, timestamp, transactionHashes: txs.map((t) => t.hash) },
      branch,
      txs,
      logs,
      meta,
    };
  }

  private scriptedTx(spec: ScriptedTx, number: number, branch: string, index: number): TxTemplate {
    const hash = (
      spec.label
        ? keccak256(stringToHex(`cers-tx-labeled|${this.chainId}|${this.seed}|${spec.label}`))
        : keccak256(stringToHex(`cers-tx|${this.chainId}|${this.seed}|${branch}|${number}|s${index}`))
    ).toLowerCase() as Hex;
    const logs = spec.logs.map((log) => this.scriptedLog(log));
    return { hash, from: resolveAccount(spec.from ?? 'alice'), to: logs[0]?.address ?? resolveAccount('bob'), logs };
  }

  private scriptedLog(log: ScriptedLog): LogTemplate {
    if (log.kind === 'raw') {
      return { address: log.address, topics: log.topics, data: log.data, meta: { kind: 'raw', expected: log.expected } };
    }
    if (log.kind === 'erc20_transfer') {
      const watch = this.resolveWatch(log.token, 'erc20_transfer');
      const from = resolveAccount(log.from);
      const to = resolveAccount(log.to);
      return {
        address: watch.address,
        ...encodeTransferLog(from, to, log.value),
        meta: { kind: 'erc20_transfer', from, to, value: log.value },
      };
    }
    const watch = this.resolveWatch(log.contract, 'settlement_recorded');
    const beneficiary = resolveAccount(log.beneficiary);
    const status = log.status ?? 1;
    const settlementId = (log.settlementId ?? keccak256(stringToHex(`settlement|${beneficiary}|${log.amount}|${status}`))).toLowerCase() as Hex;
    return {
      address: watch.address,
      ...encodeSettlementLog(settlementId, beneficiary, log.amount, status),
      meta: { kind: 'settlement_recorded', settlementId, beneficiary, amount: log.amount, status },
    };
  }

  private resolveWatch(symbolOrAddress: string, kind: EventKind): ResolvedWatch {
    const needle = symbolOrAddress.toLowerCase();
    const found = this.watch.entries.find((w) => w.symbol.toLowerCase() === needle || w.address === needle);
    if (!found) throw new Error(`fixture: no watched contract matches ${JSON.stringify(symbolOrAddress)}`);
    if (found.kind !== kind) throw new Error(`fixture: ${found.symbol} is a ${found.kind} contract, not ${kind}`);
    return found;
  }

  // ---- Seeded background traffic -----------------------------------------------------------------

  private randomTxs(number: number, branch: string, parentHash: Hex): TxTemplate[] {
    const rng = mulberry32(seedFrom(this.seed, this.chainId, branch, number, parentHash));
    const roll = rng();
    const count = roll < 0.3 ? 0 : roll < 0.8 ? 1 : 2;
    const txs: TxTemplate[] = [];
    for (let i = 0; i < count; i++) {
      const watch = this.watch.entries[Math.floor(rng() * this.watch.entries.length)];
      if (!watch) continue;
      const hash = keccak256(stringToHex(`cers-tx|${this.chainId}|${this.seed}|${branch}|${number}|r${i}`)).toLowerCase() as Hex;
      const from = this.pickAccount(rng);
      let log: LogTemplate;
      if (watch.kind === 'erc20_transfer') {
        const to = this.pickAccount(rng, from);
        const value = this.drawAmount(rng, watch);
        log = { address: watch.address, ...encodeTransferLog(from, to, value), meta: { kind: 'erc20_transfer', from, to, value } };
      } else {
        const beneficiary = this.pickAccount(rng);
        const amount = this.drawAmount(rng, watch);
        const status = Math.floor(rng() * 3);
        const settlementId = keccak256(stringToHex(`settlement|${this.chainId}|${branch}|${number}|${i}`)).toLowerCase() as Hex;
        log = {
          address: watch.address,
          ...encodeSettlementLog(settlementId, beneficiary, amount, status),
          meta: { kind: 'settlement_recorded', settlementId, beneficiary, amount, status },
        };
      }
      txs.push({ hash, from, to: watch.address, logs: [log] });
    }
    return txs;
  }

  private pickAccount(rng: () => number, not?: Hex): Hex {
    for (;;) {
      const label = ACCOUNT_LABELS[Math.floor(rng() * ACCOUNT_LABELS.length)] ?? 'alice';
      const address = syntheticAddress(`account:${label}`);
      if (address !== not) return address;
    }
  }

  /** Mostly below the threshold, sometimes exactly on its edge (-1, 0, +1 base unit), sometimes well above. */
  private drawAmount(rng: () => number, watch: ResolvedWatch): bigint {
    const t = watch.thresholdUnits;
    const r = rng();
    if (r < 0.7) return randBelow(rng, t);
    if (r < 0.85) {
      const edge = [t - 1n, t, t + 1n][Math.floor(rng() * 3)] ?? t;
      return edge < 0n ? 0n : edge;
    }
    return t * (2n + randBelow(rng, 9n)) + randBelow(rng, t);
  }
}

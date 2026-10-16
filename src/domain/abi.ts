import {
  concatHex,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  toEventSelector,
} from 'viem';
import { eventIdOf } from './identity.js';
import type { EventKind, Hex, RpcLog } from './types.js';
import type { ResolvedWatch } from './watchlist.js';

/**
 * The two event shapes the sandbox watches. viem does the ABI work (selectors, topic and data
 * encoding/decoding) so the fixture and the decoder are checked against the canonical encoding
 * rather than against hand-rolled parsing.
 */
export const erc20Abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export const settlementAbi = parseAbi([
  'event SettlementRecorded(bytes32 indexed settlementId, address indexed beneficiary, uint256 amount, uint8 status)',
]);

export const TRANSFER_TOPIC = toEventSelector(erc20Abi[0]).toLowerCase() as Hex;
export const SETTLEMENT_TOPIC = toEventSelector(settlementAbi[0]).toLowerCase() as Hex;

export interface Erc20TransferArgs {
  from: Hex;
  to: Hex;
  value: bigint;
}

export interface SettlementArgs {
  settlementId: Hex;
  beneficiary: Hex;
  amount: bigint;
  status: number;
}

export interface DecodedEvent {
  kind: EventKind;
  contract: Hex;
  chainId: number;
  blockHash: Hex;
  blockNumber: number;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  eventId: string;
  /** The value compared against the high-value threshold, in base units. */
  amount: bigint;
  args: Erc20TransferArgs | SettlementArgs;
  /** Hash of the raw log (address, topics, data); lets us detect two different payloads under one identity. */
  payloadHash: Hex;
}

export type DecodeOutcome =
  | { type: 'event'; event: DecodedEvent }
  /** Not an event we track (other topic, anonymous log, unwatched address). */
  | { type: 'ignored' }
  /** Looks like a tracked event but does not decode. Must be quarantined, never dropped silently. */
  | { type: 'undecodable'; reason: string };

export function payloadHashOf(log: Pick<RpcLog, 'address' | 'topics' | 'data'>): Hex {
  return keccak256(concatHex([log.address, ...log.topics, log.data])).toLowerCase() as Hex;
}

export function decodeWatchedLog(log: RpcLog, chainId: number, watch: ResolvedWatch): DecodeOutcome {
  const topic0 = log.topics[0]?.toLowerCase();
  const expected = watch.kind === 'erc20_transfer' ? TRANSFER_TOPIC : SETTLEMENT_TOPIC;
  if (topic0 === undefined || topic0 !== expected) return { type: 'ignored' };

  const base = {
    kind: watch.kind,
    contract: log.address.toLowerCase() as Hex,
    chainId,
    blockHash: log.blockHash.toLowerCase() as Hex,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash.toLowerCase() as Hex,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    payloadHash: payloadHashOf(log),
  };
  const eventId = eventIdOf({ chainId, blockHash: base.blockHash, transactionHash: base.transactionHash, logIndex: log.logIndex });
  const topics = log.topics as [Hex, ...Hex[]];

  try {
    if (watch.kind === 'erc20_transfer') {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics, strict: true });
      const args = {
        from: decoded.args.from.toLowerCase() as Hex,
        to: decoded.args.to.toLowerCase() as Hex,
        value: decoded.args.value,
      };
      return { type: 'event', event: { ...base, eventId, amount: args.value, args } };
    }
    const decoded = decodeEventLog({ abi: settlementAbi, data: log.data, topics, strict: true });
    const args = {
      settlementId: decoded.args.settlementId.toLowerCase() as Hex,
      beneficiary: decoded.args.beneficiary.toLowerCase() as Hex,
      amount: decoded.args.amount,
      status: decoded.args.status,
    };
    return { type: 'event', event: { ...base, eventId, amount: args.amount, args } };
  } catch (err) {
    return { type: 'undecodable', reason: (err as Error).message.split('\n')[0] ?? 'decode failed' };
  }
}

/** JSON-safe form of the decoded arguments (bigint -> decimal string) for the `decoded` jsonb column. */
export function argsToJson(event: DecodedEvent): Record<string, string | number> {
  if (event.kind === 'erc20_transfer') {
    const a = event.args as Erc20TransferArgs;
    return { from: a.from, to: a.to, value: a.value.toString() };
  }
  const a = event.args as SettlementArgs;
  return { settlementId: a.settlementId, beneficiary: a.beneficiary, amount: a.amount.toString(), status: a.status };
}

// ---- Encoding (used by the fixture to build logs the decoder must then read back) -----------------

const pad32 = (hex: string): Hex => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;

export function encodeTransferLog(from: Hex, to: Hex, value: bigint): { topics: Hex[]; data: Hex } {
  return {
    topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  };
}

export function encodeSettlementLog(
  settlementId: Hex,
  beneficiary: Hex,
  amount: bigint,
  status: number,
): { topics: Hex[]; data: Hex } {
  return {
    topics: [SETTLEMENT_TOPIC, settlementId, pad32(beneficiary)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint8' }], [amount, status]),
  };
}

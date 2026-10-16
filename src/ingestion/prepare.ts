import { decodeWatchedLog, type DecodedEvent } from '../domain/abi.js';
import { RpcError } from '../domain/errors.js';
import type { BlockHeader, Hex, RpcLog } from '../domain/types.js';
import type { WatchIndex } from '../domain/watchlist.js';

export interface QuarantinedLog {
  log: RpcLog;
  reason: string;
}

/** One block, checked and decoded, ready to be written. Nothing here has touched the database. */
export interface PreparedBlock {
  header: BlockHeader;
  /** Unique by event id, in log order. */
  events: DecodedEvent[];
  /** eventId -> how many copies of that log the provider delivered in this response. */
  copies: Map<string, number>;
  quarantined: QuarantinedLog[];
  ignoredLogs: number;
}

function inconsistent(message: string): never {
  throw new RpcError('INCONSISTENT', message);
}

/**
 * Turns one provider response (headers + logs for a block range) into prepared blocks, or refuses it.
 *
 * Every refusal is an `INCONSISTENT` RpcError, which the retry layer treats as transient: it means the
 * provider answered the header call and the log call from different views of the chain (typically a
 * reorg landing between the two). Writing such a response would attach logs to the wrong block.
 */
export function prepareBlocks(chainId: number, headers: readonly BlockHeader[], logs: readonly RpcLog[], watch: WatchIndex): PreparedBlock[] {
  const byNumber = new Map<number, BlockHeader>();
  for (const [i, header] of headers.entries()) {
    if (header.chainId !== chainId) {
      throw new Error(`provider returned a header for chain ${header.chainId}, expected ${chainId}`);
    }
    const previous = headers[i - 1];
    if (previous && (header.number !== previous.number + 1 || header.parentHash !== previous.hash)) {
      inconsistent(`headers ${previous.number}..${header.number} do not form a chain`);
    }
    byNumber.set(header.number, header);
  }

  const blocks = new Map<Hex, PreparedBlock>(
    headers.map((header) => [header.hash, { header, events: [], copies: new Map(), quarantined: [], ignoredLogs: 0 }]),
  );
  const payloadByEvent = new Map<string, Hex>();
  const seenQuarantine = new Set<string>();

  const ordered = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  for (const log of ordered) {
    const header = byNumber.get(log.blockNumber);
    if (!header) inconsistent(`log for block ${log.blockNumber} is outside the requested range`);
    if (header && log.blockHash.toLowerCase() !== header.hash) {
      inconsistent(`log claims block ${log.blockHash} but the header held for height ${log.blockNumber} is ${header.hash}`);
    }
    if (header && !header.transactionHashes.includes(log.transactionHash.toLowerCase() as Hex)) {
      inconsistent(`log transaction ${log.transactionHash} is not in block ${header.number}`);
    }
    const block = header ? blocks.get(header.hash) : undefined;
    if (!block) continue;

    const entry = watch.byAddress.get(log.address.toLowerCase() as Hex);
    if (!entry) {
      block.ignoredLogs += 1;
      continue;
    }
    const outcome = decodeWatchedLog(log, chainId, entry);
    if (outcome.type === 'ignored') {
      block.ignoredLogs += 1;
    } else if (outcome.type === 'undecodable') {
      const key = `${log.blockHash}:${log.transactionHash}:${log.logIndex}`;
      if (!seenQuarantine.has(key)) {
        seenQuarantine.add(key);
        block.quarantined.push({ log, reason: outcome.reason });
      }
    } else {
      const { event } = outcome;
      const previousPayload = payloadByEvent.get(event.eventId);
      if (previousPayload !== undefined && previousPayload !== event.payloadHash) {
        inconsistent(`two different payloads delivered for event ${event.eventId}`);
      }
      payloadByEvent.set(event.eventId, event.payloadHash);
      const seen = block.copies.get(event.eventId) ?? 0;
      block.copies.set(event.eventId, seen + 1);
      if (seen === 0) block.events.push(event);
    }
  }
  return headers.map((h) => blocks.get(h.hash) as PreparedBlock);
}

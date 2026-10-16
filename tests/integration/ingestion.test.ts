import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InjectedCrash } from '../../src/observability/failpoints.js';
import { Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows, highValueCount } from '../../scenarios/oracle.js';

/**
 * Vertical slice: fixture chain -> scanner -> PostgreSQL -> checkpoint. Everything is compared with
 * what the fixture itself says it emitted, not with what the scanner reports.
 */

describe('baseline ingestion', () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await Sandbox.create({ traffic: 'random', seed: 'baseline', confirmationDepth: 3, batchSize: 5 });
    sb.chain.mine(40);
    await sb.scanner.scanOnce('startup');
  });
  afterAll(async () => sb.destroy());

  it('stores exactly the events the fixture emitted - no gaps, no extras', async () => {
    const expected = sb.chain.expectedEvents();
    expect(expected.length).toBeGreaterThan(15);
    expect(highValueCount(expected)).toBeGreaterThan(0); // the comparisons below must not be vacuous
    expect(diffCanonical(await sb.events(), expected)).toEqual(EMPTY_DIFF);
  });

  it('moves the checkpoint to the head, with the head\'s hash', async () => {
    expect(await sb.checkpoint()).toMatchObject({ number: 40, hash: sb.chain.head.hash, status: 'ok' });
  });

  it('stores a contiguous, linked canonical chain from genesis to the head', async () => {
    const blocks = await sb.canonicalBlocks();
    expect(blocks.map((b) => b.number)).toEqual([...Array(41).keys()]);
    expect(blocks.map((b) => b.hash)).toEqual([...Array(41).keys()].map((n) => sb.chain.blockAt(n)!.header.hash));
  });

  it('confirms an event only when `depth` blocks sit on top of it (head 40, depth 3 -> blocks <= 37)', async () => {
    const events = await sb.events();
    for (const e of events) {
      expect(e.status, `block ${e.blockNumber}`).toBe(e.blockNumber <= 37 ? 'confirmed' : 'provisional');
    }
    expect(events.some((e) => e.status === 'confirmed')).toBe(true);
    expect(events.some((e) => e.status === 'provisional')).toBe(true);
  });

  it('opens one alert per high-value event and keeps derived totals equal to an independent fold', async () => {
    const expected = sb.chain.expectedEvents();
    expect((await sb.alerts()).open).toBe(highValueCount(expected));
    expect(await sb.flows()).toEqual(expectedFlows(expected));
  });

  it('queues notifications only for confirmed high-value events', async () => {
    const events = await sb.events();
    const confirmedHigh = (await sb.alerts()).open === 0 ? 0 : await sb.count('outbox', "notification_type = 'event_confirmed'");
    const expectedConfirmedHigh = sb.chain
      .expectedEvents()
      .filter((e) => e.highValue && e.blockNumber <= 37).length;
    expect(expectedConfirmedHigh).toBeGreaterThan(0);
    expect(confirmedHigh).toBe(expectedConfirmedHigh);
    expect(events.filter((e) => e.status === 'provisional').length).toBeGreaterThan(0); // provisional ones exist, yet queued nothing for them
  });

  it('satisfies every stored-state invariant', async () => {
    const report = await sb.invariants();
    expect(report.checks.filter((c) => c.violations > 0)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('records each event\'s first transition as observed -> provisional in the audit trail', async () => {
    const { rows } = await sb.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM event_audit WHERE action = 'ingested' AND from_state = 'observed' AND to_state = 'provisional'`,
    );
    expect(rows[0]?.n).toBe(sb.chain.expectedEvents().length);
  });

  it('continues incrementally from the stored checkpoint', async () => {
    const before = await sb.events();
    sb.chain.mine(3);
    const report = await sb.scanner.scanOnce('notification');
    expect(report.outcome).toBe('caught_up');
    expect(report.blocksIngested).toBe(3);
    expect((await sb.checkpoint()).number).toBe(43);
    const after = await sb.events();
    for (const e of before) expect(after.find((x) => x.eventId === e.eventId)).toBeDefined();
    expect(diffCanonical(after, sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('a worker restart', () => {
  it('resumes from the durable checkpoint and a fresh scanner finds nothing left to do', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'restart', batchSize: 7 });
    try {
      sb.chain.mine(25);
      await sb.scanner.scanOnce('startup');
      const checkpoint = await sb.checkpoint();

      const restarted = sb.newScanner();
      const report = await restarted.scanOnce('startup');
      expect(report.blocksIngested).toBe(0);
      expect(report.eventsInserted).toBe(0);
      expect(await sb.checkpoint()).toEqual(checkpoint);
      expect(sb.logs.count('scanner.resume')).toBe(1);
      expect(await sb.count('recovery_log', "kind = 'resume'")).toBe(1);
    } finally {
      await sb.destroy();
    }
  });
});

describe('checkpoint advancement is atomic with the data it describes', () => {
  it('a crash before COMMIT leaves neither the batch nor a checkpoint for it', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'atomic', batchSize: 5 });
    try {
      sb.chain.mine(20);
      sb.crash.arm('scanner.before_commit', { afterHits: 1 }); // 2nd batch (blocks 5-9) dies just before commit
      await expect(sb.scanner.scanOnce('startup')).rejects.toBeInstanceOf(InjectedCrash);

      // First batch (blocks 0-4) committed; the second left no trace at all.
      expect(await sb.checkpoint()).toMatchObject({ number: 4 });
      expect((await sb.canonicalBlocks()).map((b) => b.number)).toEqual([0, 1, 2, 3, 4]);
      const stored = await sb.events();
      expect(Math.max(0, ...stored.map((e) => e.blockNumber))).toBeLessThanOrEqual(4);
      expect((await sb.invariants()).ok).toBe(true);

      // A new worker continues from block 5 and ends up with the complete, correct state.
      await sb.newScanner().scanOnce('startup');
      expect(await sb.checkpoint()).toMatchObject({ number: 20 });
      expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
      expect((await sb.invariants()).ok).toBe(true);
    } finally {
      await sb.destroy();
    }
  });

  it('a crash right after COMMIT loses nothing: the committed batch and its checkpoint are durable', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'atomic2', batchSize: 5 });
    try {
      sb.chain.mine(20);
      sb.crash.arm('scanner.after_commit', { afterHits: 0 });
      await expect(sb.scanner.scanOnce('startup')).rejects.toBeInstanceOf(InjectedCrash);
      expect(await sb.checkpoint()).toMatchObject({ number: 4 });
      const firstBatch = [0, 1, 2, 3, 4].map((n) => sb.chain.blockAt(n)!);
      expect((await sb.events()).length).toBe(sb.chain.expectedEvents(firstBatch).length);

      await sb.newScanner().scanOnce('startup');
      expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    } finally {
      await sb.destroy();
    }
  });
});

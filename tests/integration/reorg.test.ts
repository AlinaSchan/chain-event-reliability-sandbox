import { afterEach, describe, expect, it } from 'vitest';
import { FixtureChain } from '../../src/fixtures/chain.js';
import { FixtureProvider } from '../../src/fixtures/provider.js';
import { Scanner } from '../../src/ingestion/scanner.js';
import { InjectedCrash } from '../../src/observability/failpoints.js';
import { block, minePlan, settlement, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows } from '../../scenarios/oracle.js';

/**
 * Chain history used by most tests below (confirmation depth 3, so at head 14 events in blocks <= 11 are confirmed):
 *   4  USDX  alice -> bob    20,000   high
 *   9  USDX  bob   -> carol  15,000   high
 *  11  WRAPX alice -> bob         6   high
 *  12  USDX  carol -> dave   12,000   high   (tx label "D")
 *  13  GOLDX alice -> dave      150   high
 *  14  USDX  dave  -> erin      100   low
 */
const history = () => ({
  4: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  9: block(tx(transfer('USDX', 'bob', 'carol', '15000'))),
  11: block(tx(transfer('WRAPX', 'alice', 'bob', '6'))),
  12: block(tx(transfer('USDX', 'carol', 'dave', '12000'), 'D')),
  13: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))),
  14: block(tx(transfer('USDX', 'dave', 'erin', '100'))),
});

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});

async function atHead14(opts: { maxReorgDepth?: number; confirmationDepth?: number } = {}): Promise<Sandbox> {
  const sb = await Sandbox.create({ confirmationDepth: 3, batchSize: 5, ...opts });
  sandboxes.push(sb);
  minePlan(sb.chain, history());
  await sb.scanner.scanOnce('startup');
  return sb;
}

/** Replaces blocks 12..14 with four blocks; tx "D" is re-included in 13' and a high-value settlement lands in 14'. */
function shallowReorg(sb: Sandbox) {
  return sb.chain.reorg({
    depth: 3,
    replacement: 4,
    branch: 'B',
    specs: [undefined, block(tx(transfer('USDX', 'carol', 'dave', '12000'), 'D')), block(tx(settlement('erin', '300000'))), undefined],
  });
}

async function fingerprint(sb: Sandbox): Promise<string> {
  const events = (await sb.events()).map((e) => [e.eventId, e.status, e.amount.toString(), e.confirmCount]);
  const flows = (await sb.flows()).map((f) => [f.token, f.account, f.inbound.toString(), f.outbound.toString()]);
  const outbox = (
    await sb.db.query<{ notification_id: string; status: string }>('SELECT notification_id, status FROM outbox ORDER BY notification_id')
  ).rows.map((r) => [r.notification_id, r.status]);
  return JSON.stringify({ cp: await sb.checkpoint().then((c) => [c.number, c.hash]), events, flows, alerts: await sb.alerts(), outbox, blocks: await sb.canonicalBlocks() });
}

describe('shallow reorganization', () => {
  it('orphans the abandoned branch, applies the replacement, corrects derived state and leaves an audit trail', async () => {
    const sb = await atHead14();
    const before = await sb.events();
    expect(before.filter((e) => e.status === 'confirmed').map((e) => e.blockNumber)).toEqual([4, 9, 11]);
    expect(before.filter((e) => e.status === 'provisional').map((e) => e.blockNumber)).toEqual([12, 13, 14]);
    const abandoned = [12, 13, 14].map((n) => sb.chain.blockAt(n)!.header.hash);
    const oldD = before.find((e) => e.blockNumber === 12)!;

    shallowReorg(sb);
    const report = await sb.scanner.scanOnce('notification');

    expect(report.outcome).toBe('caught_up');
    expect(report.reorgs).toBe(1);
    expect(sb.logs.count('reorg.detected')).toBe(1);
    expect(sb.logs.count('reorg.applied')).toBe(1);

    // Blocks: the stored canonical chain is the new branch; abandoned blocks are kept, flagged, with a reason.
    expect((await sb.canonicalBlocks()).map((b) => b.hash)).toEqual([...Array(16).keys()].map((n) => sb.chain.blockAt(n)!.header.hash));
    const { rows: flagged } = await sb.db.query<{ block_hash: string; orphan_reason: string }>(
      'SELECT block_hash, orphan_reason FROM chain_blocks WHERE NOT canonical ORDER BY block_number',
    );
    expect(flagged.map((b) => b.block_hash)).toEqual(abandoned);
    expect(flagged.every((b) => /no longer on the provider's canonical chain/.test(b.orphan_reason))).toBe(true);

    // Events: old ones are orphaned, not deleted. The same transaction in the new block is a new event.
    const after = await sb.events();
    expect(after.filter((e) => e.status === 'orphaned').map((e) => e.blockNumber)).toEqual([12, 13, 14]);
    const newD = after.find((e) => e.status !== 'orphaned' && e.blockNumber === 13 && e.kind === 'erc20_transfer')!;
    expect(newD.eventId).not.toBe(oldD.eventId);
    expect(newD.status).toBe('provisional');
    expect(diffCanonical(after, sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);

    // Derived state: totals are the fold over the new canonical chain; alerts follow the events.
    expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));
    expect(await sb.alerts()).toEqual({ open: 5, withdrawn: 2 }); // 4, 9, 11, D', settlement open; D and GOLDX withdrawn

    // Notifications: only the three already-confirmed events have any. Nothing for orphaned or provisional events.
    const { rows: outbox } = await sb.db.query<{ event_id: string; status: string }>('SELECT event_id, status FROM outbox');
    expect(outbox).toHaveLength(3);
    expect(outbox.every((o) => o.status === 'pending')).toBe(true);
    expect(outbox.map((o) => o.event_id)).not.toContain(oldD.eventId);

    // Audit: the orphaned event's history reads ingested -> orphaned, with the ancestor in the details.
    const { rows: audit } = await sb.db.query<{ action: string; from_state: string; to_state: string }>(
      'SELECT action, from_state, to_state FROM event_audit WHERE event_id = $1 ORDER BY id',
      [oldD.eventId],
    );
    expect(audit).toEqual([
      { action: 'ingested', from_state: 'observed', to_state: 'provisional' },
      { action: 'orphaned', from_state: 'provisional', to_state: 'orphaned' },
    ]);

    // Recovery evidence and no incident (no confirmed event was touched).
    const { rows: log } = await sb.db.query<{ kind: string; from_block: number; to_block: number; details: { depth: number; commonAncestor: { number: number } } }>(
      "SELECT kind, from_block, to_block, details FROM recovery_log WHERE kind = 'reorg'",
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ from_block: 12, to_block: 14, details: { depth: 3, commonAncestor: { number: 11 } } });
    expect(await sb.count('incidents')).toBe(0);
    expect((await sb.invariants()).checks.filter((c) => c.violations > 0)).toEqual([]);
  });

  it('is idempotent: scanning again and replaying the whole range changes nothing', async () => {
    const sb = await atHead14();
    shallowReorg(sb);
    await sb.scanner.scanOnce('notification');
    const settled = await fingerprint(sb);
    const transitions = await sb.count('event_audit', "action IN ('ingested','orphaned','confirmed','reactivated')");

    expect((await sb.scanner.scanOnce('poll')).blocksIngested).toBe(0);
    await sb.newScanner().replayRange(0, 15);

    expect(await fingerprint(sb)).toBe(settled);
    expect(await sb.count('event_audit', "action IN ('ingested','orphaned','confirmed','reactivated')")).toBe(transitions);
    expect(await sb.count('recovery_log', "kind = 'reorg'")).toBe(1);
  });

  it('a crash before COMMIT while correcting a reorg leaves the old state intact, and restart converges to the same result as a clean run', async () => {
    const control = await atHead14();
    shallowReorg(control);
    await control.scanner.scanOnce('notification');

    const sb = await atHead14();
    const preReorg = await fingerprint(sb);
    shallowReorg(sb);
    sb.crash.arm('scanner.before_commit');
    await expect(sb.scanner.scanOnce('notification')).rejects.toBeInstanceOf(InjectedCrash);
    expect(await fingerprint(sb)).toBe(preReorg); // nothing of the correction survived, not even a partial orphaning

    await sb.newScanner().scanOnce('startup');
    expect(await fingerprint(sb)).toBe(await fingerprint(control));
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('a crash right after COMMIT of the correction needs no further correction on restart', async () => {
    const sb = await atHead14();
    shallowReorg(sb);
    sb.crash.arm('scanner.after_commit');
    await expect(sb.scanner.scanOnce('notification')).rejects.toBeInstanceOf(InjectedCrash);
    const durable = await fingerprint(sb);

    const restarted = await sb.newScanner().scanOnce('startup');
    expect(restarted.reorgs).toBe(0);
    expect(await fingerprint(sb)).toBe(durable);
    expect(await sb.count('recovery_log', "kind = 'reorg'")).toBe(1);
  });

  it('detects a tip replaced at the same height, before any new block exists', async () => {
    const sb = await atHead14();
    sb.chain.reorg({ depth: 1, replacement: 1, branch: 'B' });
    expect(sb.chain.head.number).toBe(14);
    const report = await sb.scanner.scanOnce('poll');
    expect(report.reorgs).toBe(1);
    expect((await sb.checkpoint()).hash).toBe(sb.chain.head.hash);
    expect((await sb.events()).filter((e) => e.status === 'orphaned').map((e) => e.blockNumber)).toEqual([14]);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
  });

  it('handles a replacement branch that is shorter than the one it replaces', async () => {
    const sb = await atHead14();
    sb.chain.reorg({ depth: 3, replacement: 1, branch: 'B' }); // head goes 14 -> 12
    const report = await sb.scanner.scanOnce('poll');
    expect(report.reorgs).toBe(1);
    expect(await sb.checkpoint()).toMatchObject({ number: 12, hash: sb.chain.head.hash });
    expect((await sb.events()).filter((e) => e.status === 'orphaned').map((e) => e.blockNumber)).toEqual([12, 13, 14]);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('applies a long replacement branch across several batches and still ends fully consistent', async () => {
    const sb = await atHead14();
    sb.chain.reorg({ depth: 3, replacement: 12, branch: 'B' }); // 12 new blocks, batch size 5
    const report = await sb.scanner.scanOnce('poll');
    expect(report.reorgs).toBe(1); // one correction, then ordinary forward batches
    expect(report.steps).toBeGreaterThan(2);
    expect((await sb.checkpoint()).number).toBe(23);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('a provider that is behind, or answers from a stale cache', () => {
  it('does not treat a lagging head as a reorganization and does not move the checkpoint backwards', async () => {
    const sb = await atHead14();
    const before = await fingerprint(sb);

    // One answer from a node that is 2 blocks behind: head 12, which is a prefix of the chain we stored.
    sb.provider.faults.add({ method: 'getHead', action: 'lagging', times: 1, lagBlocks: 2 });
    const report = await sb.scanner.scanOnce('poll');

    expect(report.outcome).toBe('provider_behind');
    expect(sb.logs.count('provider.behind')).toBe(1);
    expect(report.reorgs).toBe(0);
    expect(await fingerprint(sb)).toBe(before);

    // The next, healthy answer finds nothing to do either.
    expect((await sb.scanner.scanOnce('poll')).outcome).toBe('caught_up');
  });

  it('treats a head below startBlock as a provider that is behind: nothing is stored down there to compare it with', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 3, batchSize: 50, startBlock: 5 });
    sandboxes.push(sb);
    minePlan(sb.chain, history());
    await sb.scanner.scanOnce('startup');
    expect((await sb.checkpoint()).number).toBe(14);
    const before = await fingerprint(sb);

    // One answer from a node that is 12 blocks behind: head 2, below the first block this deployment ingests.
    // There is no stored block at that height, so "different from ours" cannot be established - and without
    // that, a short head is not evidence of a reorganization.
    sb.provider.faults.add({ method: 'getHead', action: 'lagging', times: 1, lagBlocks: 12 });
    const report = await sb.scanner.scanOnce('poll');

    expect(report.outcome).toBe('provider_behind');
    expect(report.reorgs).toBe(0);
    expect((await sb.checkpoint()).status).not.toBe('halted');
    expect(await sb.count('incidents')).toBe(0);
    expect(await fingerprint(sb)).toBe(before);
    expect((await sb.scanner.scanOnce('poll')).outcome).toBe('caught_up'); // the next, healthy answer carries on
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('still halts when a head at or above startBlock disagrees with a stored block it can be compared with', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 3, batchSize: 50, startBlock: 5, maxReorgDepth: 3 });
    sandboxes.push(sb);
    minePlan(sb.chain, history());
    await sb.scanner.scanOnce('startup');

    // The whole stored range above the anchor is replaced: no common ancestor within maxReorgDepth.
    sb.chain.reorg({ depth: 10, replacement: 10, branch: 'Z' });
    const report = await sb.scanner.scanOnce('poll');
    expect(report.outcome).toBe('halted');
    expect(await sb.count('incidents', "kind = 'scanner_halted' AND status = 'open'")).toBe(1);
  });

  it('ignores a repeated (stale) head response that equals what is already stored, and still sees real progress afterwards', async () => {
    const sb = await atHead14();
    sb.chain.mine(2);
    sb.provider.faults.add({ method: 'getHead', action: 'stale', times: 1 }); // returns the previous answer: head 14 again
    const stale = await sb.scanner.scanOnce('poll');
    expect(stale.outcome).toBe('caught_up');
    expect((await sb.checkpoint()).number).toBe(14); // the two new blocks are not visible yet

    const fresh = await sb.scanner.scanOnce('poll');
    expect(fresh.blocksIngested).toBe(2);
    expect((await sb.checkpoint()).number).toBe(16);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('re-canonicalization (a reorg followed by a reorg back)', () => {
  it('restores the events of a block that comes back, instead of leaving canonical events orphaned forever', async () => {
    const sb = await atHead14();
    const tipA = sb.chain.head;
    const control = await fingerprint(sb);

    shallowReorg(sb); // A -> B
    await sb.scanner.scanOnce('poll');
    expect((await sb.events()).filter((e) => e.status === 'orphaned')).toHaveLength(3);

    sb.chain.setCanonicalTip(tipA.hash); // B -> A again
    const report = await sb.scanner.scanOnce('poll');
    expect(report.reorgs).toBe(1);
    expect(report.eventsReactivated).toBe(3);

    const events = await sb.events();
    expect(diffCanonical(events, sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect(events.filter((e) => e.status === 'orphaned').map((e) => e.blockNumber)).toEqual([13, 14]); // branch B's two events
    // The re-canonicalized events carry the history: ingested, orphaned, reactivated.
    const oldD = events.find((e) => e.blockNumber === 12 && e.status !== 'orphaned')!;
    const { rows } = await sb.db.query<{ action: string }>('SELECT action FROM event_audit WHERE event_id = $1 ORDER BY id', [oldD.eventId]);
    expect(rows.map((r) => r.action)).toEqual(['ingested', 'orphaned', 'reactivated']);
    expect(oldD.seenCount).toBe(2);
    // Same visible state as before the A -> B -> A round trip, apart from the extra orphaned B rows.
    expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));
    expect((await sb.checkpoint()).hash).toBe(tipA.hash);
    expect((await sb.invariants()).ok).toBe(true);
    expect(JSON.parse(control).cp).toEqual(JSON.parse(await fingerprint(sb)).cp);
  });
});

describe('reorganization deeper than the confirmation depth', () => {
  it('orphans confirmed events too, but opens a critical incident that asks for manual review', async () => {
    const sb = await atHead14({ maxReorgDepth: 10 });
    expect((await sb.events()).filter((e) => e.status === 'confirmed').map((e) => e.blockNumber)).toEqual([4, 9, 11]);

    sb.chain.reorg({ depth: 6, replacement: 7, branch: 'B' }); // replaces blocks 9..14: orphans confirmed events at 9 and 11
    await sb.scanner.scanOnce('poll');

    const events = await sb.events();
    expect(events.filter((e) => e.status === 'orphaned').map((e) => e.blockNumber)).toEqual([9, 11, 12, 13, 14]);
    expect(events.find((e) => e.blockNumber === 4)?.status).toBe('confirmed'); // below the ancestor: untouched
    expect(diffCanonical(events, sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);

    const { rows: incidents } = await sb.db.query<{ kind: string; severity: string; requires_manual_review: boolean; status: string; details: { confirmedEventIds: string[] } }>(
      'SELECT kind, severity, requires_manual_review, status, details FROM incidents',
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: 'confirmed_event_orphaned', severity: 'critical', requires_manual_review: true, status: 'open' });
    expect(incidents[0]!.details.confirmedEventIds).toHaveLength(2);

    // Their notifications had not been delivered yet, so they are suppressed rather than retracted.
    const { rows: outbox } = await sb.db.query<{ status: string }>(
      "SELECT status FROM outbox WHERE event_id = ANY($1::text[])",
      [events.filter((e) => [9, 11].includes(e.blockNumber) && e.status === 'orphaned').map((e) => e.eventId)],
    );
    expect(outbox.map((o) => o.status)).toEqual(['suppressed', 'suppressed']);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('queues a retraction for a notification that had already been delivered', async () => {
    const sb = await atHead14();
    const delivered = (await sb.events()).find((e) => e.blockNumber === 9)!;
    // Stand-in for the consumer having delivered it already (the real consumer is covered in the queue tests).
    await sb.db.query("UPDATE outbox SET status = 'processed', processed_at = now() WHERE event_id = $1", [delivered.eventId]);
    await sb.db.query(
      `INSERT INTO notification_sink (notification_id, chain_id, event_id, notification_type, payload, event_status_at_delivery)
       SELECT notification_id, chain_id, event_id, notification_type, payload, 'confirmed' FROM outbox WHERE event_id = $1`,
      [delivered.eventId],
    );

    sb.chain.reorg({ depth: 6, replacement: 7, branch: 'B' });
    await sb.scanner.scanOnce('poll');

    const { rows } = await sb.db.query<{ notification_type: string; status: string }>(
      'SELECT notification_type, status FROM outbox WHERE event_id = $1 ORDER BY id',
      [delivered.eventId],
    );
    expect(rows).toEqual([
      { notification_type: 'event_confirmed', status: 'processed' },
      { notification_type: 'event_retracted', status: 'pending' },
    ]);
    const { rows: incidents } = await sb.db.query<{ summary: string }>('SELECT summary FROM incidents');
    expect(incidents[0]!.summary).toMatch(/1 had been delivered downstream/);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

describe('reorganization deeper than the automatic rollback limit', () => {
  it('halts with diagnostics instead of guessing, changes no data, and stays halted', async () => {
    const sb = await atHead14({ maxReorgDepth: 4 });
    const before = await fingerprint(sb);

    sb.chain.reorg({ depth: 8, replacement: 9, branch: 'B' }); // ancestor 6; stored tip 14 is 8 blocks away > 4
    const report = await sb.scanner.scanOnce('poll');

    expect(report.outcome).toBe('halted');
    expect(await fingerprint(sb)).toBe(before); // no data touched
    const cp = await sb.checkpoint();
    expect(cp.status).toBe('halted');
    const { rows } = await sb.db.query<{ status_detail: { reason: string; maxReorgDepth: number; storedTip: { number: number }; providerHead: { number: number }; searchedDownTo: number } }>(
      'SELECT status_detail FROM scanner_checkpoints',
    );
    expect(rows[0]!.status_detail).toMatchObject({
      reason: 'no_common_ancestor_within_max_reorg_depth',
      maxReorgDepth: 4,
      storedTip: { number: 14 },
      providerHead: { number: 15 },
      searchedDownTo: 10,
    });
    expect(await sb.count('incidents', "kind = 'scanner_halted' AND status = 'open' AND requires_manual_review")).toBe(1);
    expect(await sb.count('recovery_log', "kind = 'halt'")).toBe(1);
    expect(sb.logs.count('scanner.halted')).toBe(1);

    // Still halted on the next cycle, with no second incident and no writes.
    expect((await sb.newScanner().scanOnce('poll')).outcome).toBe('halted');
    expect(await sb.count('incidents')).toBe(1);
    expect(await fingerprint(sb)).toBe(before);
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('recovers after an operator clears the halt and the limit allows the rollback', async () => {
    const sb = await atHead14({ maxReorgDepth: 4 });
    sb.chain.reorg({ depth: 8, replacement: 9, branch: 'B' });
    await sb.scanner.scanOnce('poll');

    const wider = sb.newScanner({ maxReorgDepth: 12 });
    expect(await wider.unhalt('limit raised to 12 after reviewing the provider incident')).toBe(true);
    expect(await sb.count('incidents', "kind = 'scanner_halted' AND status = 'resolved'")).toBe(1);

    const report = await wider.scanOnce('manual');
    expect(report.reorgs).toBe(1);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect((await sb.checkpoint()).status).toBe('ok');
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('also halts when the provider disagrees with every stored block down to the start (a different chain entirely)', async () => {
    const sb = await atHead14({ maxReorgDepth: 50 });
    // Same chain id, different genesis: nothing it serves matches anything we stored.
    const other = new FixtureChain({ chainId: sb.chainId, seed: 'a-different-universe', watch: sb.watch, traffic: 'scripted', genesisTimestamp: 1_800_000_000 });
    other.mine(20);
    const scanner = new Scanner(
      { db: sb.db, provider: new FixtureProvider(other), watch: sb.watch, logger: sb.logs.logger(), metrics: sb.metrics, sleep: () => Promise.resolve() },
      sb.scannerConfig({ maxReorgDepth: 50 }),
    );
    expect((await scanner.scanOnce('poll')).outcome).toBe('halted');
    expect((await sb.checkpoint()).status).toBe('halted');
    expect((await sb.events()).every((e) => e.status !== 'orphaned')).toBe(true); // nothing was rolled back on a guess
  });
});

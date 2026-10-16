import { afterEach, describe, expect, it } from 'vitest';
import { ReplayMismatchError } from '../../src/domain/errors.js';
import type { Hex } from '../../src/domain/types.js';
import { applyBatch } from '../../src/ingestion/apply.js';
import { prepareBlocks } from '../../src/ingestion/prepare.js';
import { silentLogger } from '../../src/observability/logger.js';
import { block, minePlan, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows } from '../../scenarios/oracle.js';

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});
const create = async (opts: Parameters<typeof Sandbox.create>[0]): Promise<Sandbox> => {
  const sb = await Sandbox.create(opts);
  sandboxes.push(sb);
  return sb;
};

const plan = () => ({
  2: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  3: block(tx([transfer('USDX', 'bob', 'carol', '15000'), transfer('GOLDX', 'alice', 'dave', '150')])), // two logs, ONE transaction
  4: block(tx(transfer('WRAPX', 'carol', 'erin', '7'))),
});

async function logicalEffects(sb: Sandbox) {
  return {
    events: (await sb.events()).map((e) => [e.eventId, e.status, e.amount.toString()]),
    flows: (await sb.flows()).map((f) => [f.token, f.account, f.inbound.toString(), f.outbound.toString()]),
    alerts: await sb.alerts(),
    outbox: await sb.count('outbox'),
    transitions: await sb.count('event_audit', "action IN ('ingested','confirmed','orphaned','reactivated')"),
  };
}

describe('repeated delivery produces one logical effect', () => {
  it('a provider that returns every log twice still yields one event, one total and one alert each', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, plan(), 8);
    sb.provider.faults.add({ method: 'getLogs', action: 'duplicate_logs', times: 100 });

    await sb.scanner.scanOnce('startup');

    const events = await sb.events();
    expect(events).toHaveLength(4);
    expect(diffCanonical(events, sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect(events.every((e) => e.seenCount === 2)).toBe(true); // delivered twice, stored once
    expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents())); // not doubled
    expect((await sb.alerts()).open).toBe(4);
    const { rows } = await sb.db.query<{ n: number }>("SELECT count(*)::int AS n FROM event_audit WHERE action = 'duplicate_sighting'");
    expect(rows[0]?.n).toBe(4); // the repeats are on the record
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('replaying an already-processed range any number of times changes no logical effect', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, plan(), 8);
    await sb.scanner.scanOnce('startup');
    const settled = await logicalEffects(sb);

    for (let i = 0; i < 3; i++) {
      const report = await sb.newScanner().replayRange(0, 8);
      expect(report.eventsInserted).toBe(0);
      expect(report.eventsDuplicate).toBe(4);
    }

    expect(await logicalEffects(sb)).toEqual(settled);
    const events = await sb.events();
    expect(events.every((e) => e.seenCount === 4)).toBe(true); // first sighting + three replays
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('heals a gap: a replay inserts what is missing and leaves everything already correct untouched', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, plan(), 8);
    await sb.scanner.scanOnce('startup');
    const victim = (await sb.events()).find((e) => e.blockNumber === 3 && e.logIndex === 1)!;
    // Simulate lost data: remove one event and everything derived from it (as a restored backup might).
    await sb.db.query('DELETE FROM notification_sink WHERE event_id = $1', [victim.eventId]);
    await sb.db.query('DELETE FROM outbox WHERE event_id = $1', [victim.eventId]);
    await sb.db.query('DELETE FROM alerts WHERE event_id = $1', [victim.eventId]);
    await sb.db.query('DELETE FROM event_audit WHERE event_id = $1', [victim.eventId]);
    await sb.db.query('DELETE FROM chain_events WHERE event_id = $1', [victim.eventId]);
    await sb.db.query(
      "UPDATE account_flows SET outbound = outbound - 150, inbound = inbound WHERE account = $1 AND token_address = $2",
      [(sb.chain.expectedEvents().find((e) => e.eventId === victim.eventId)!.meta as { from: Hex }).from, victim.contract],
    );
    await sb.db.query("UPDATE account_flows SET inbound = inbound - 150 WHERE account = $1 AND token_address = $2", [
      (sb.chain.expectedEvents().find((e) => e.eventId === victim.eventId)!.meta as { to: Hex }).to,
      victim.contract,
    ]);
    expect((await sb.invariants()).ok).toBe(true); // the gap is invisible to a state check...

    const report = await sb.newScanner().replayRange(0, 8);

    expect(report.eventsInserted).toBe(1); // ...but the replay finds it and fills it
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    // The block is already deep, so the healed event is inserted as provisional and confirmed in the same transaction.
    const { rows: audit } = await sb.db.query<{ action: string }>('SELECT action FROM event_audit WHERE event_id = $1 ORDER BY id', [victim.eventId]);
    expect(audit.map((a) => a.action)).toEqual(['ingested', 'confirmed']);
    expect(await sb.count('outbox', 'event_id = $2', [victim.eventId])).toBe(1);
    expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));
    expect((await sb.invariants()).ok).toBe(true);
  });

  it('refuses a replay batch for heights that are no longer stored (the chain shrank after the range was read) instead of writing above the checkpoint', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, plan(), 8);
    await sb.scanner.scanOnce('startup');

    // A replay reads blocks 6..8 ...
    const headers = [6, 7, 8].map((n) => sb.chain.getHeaderByNumber(n)!);
    const batch = prepareBlocks(sb.chainId, headers, sb.chain.logsInRange(6, 8, sb.watch.addresses), sb.watch);
    // ... and before it applies them a reorganization replaces the tip with a shorter branch (head 8 -> 5).
    sb.chain.reorg({ depth: 4, replacement: 1, branch: 'S' });
    await sb.scanner.scanOnce('poll');
    expect((await sb.checkpoint()).number).toBe(5);
    const settled = await sb.fingerprint();

    await expect(
      applyBatch(
        { db: sb.db, logger: silentLogger(), metrics: sb.metrics },
        { chainId: sb.chainId, mode: 'replay', trigger: 'manual', expectedVersion: null, blocks: batch, confirmationDepth: 2, watch: sb.watch },
      ),
    ).rejects.toBeInstanceOf(ReplayMismatchError);
    expect(await sb.fingerprint()).toBe(settled); // nothing was written
    expect((await sb.canonicalBlocks()).at(-1)?.number).toBe(5);
    expect((await sb.invariants()).checks.filter((c) => c.violations > 0)).toEqual([]);
  });

  it('a different payload under an identity that is already stored is kept out and escalated, not applied', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, plan(), 8);
    await sb.scanner.scanOnce('startup');
    const before = await logicalEffects(sb);

    // The provider now serves a *different* amount for the same (block, tx, log index).
    const log = sb.chain.blockAt(2)!.logs[0]!;
    (log as { data: Hex }).data = `0x${'00'.repeat(31)}01`;
    await sb.newScanner().replayRange(2, 2);

    expect(await sb.count('incidents', "kind = 'payload_mismatch' AND requires_manual_review")).toBe(1);
    expect(await sb.count('event_audit', "action = 'payload_mismatch'")).toBe(1);
    const after = await logicalEffects(sb);
    expect({ ...after, transitions: before.transitions }).toEqual(before); // stored amount, totals and alerts did not change
  });
});

describe('repeated head notifications', () => {
  it('a burst of duplicate notifications for one block causes one block to be ingested once', async () => {
    const sb = await create({ confirmationDepth: 2 });
    minePlan(sb.chain, plan(), 6);
    await sb.scanner.scanOnce('startup');
    const before = await logicalEffects(sb);

    // Five scans triggered by the same new head, as a WebSocket that repeats itself would cause.
    sb.chain.mineOne(block(tx(transfer('USDX', 'dave', 'erin', '99999'))));
    const reports = [];
    for (let i = 0; i < 5; i++) reports.push(await sb.scanner.scanOnce('notification'));

    expect(reports.map((r) => r.blocksIngested)).toEqual([1, 0, 0, 0, 0]);
    const after = await logicalEffects(sb);
    expect(after.events.length).toBe(before.events.length + 1);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

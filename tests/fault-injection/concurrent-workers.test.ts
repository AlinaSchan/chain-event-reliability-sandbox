import { afterEach, describe, expect, it } from 'vitest';
import { Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows } from '../../scenarios/oracle.js';

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});

/**
 * "Single writer" here is enforced by the database, not by assuming one process exists: every commit
 * takes the checkpoint row lock and compares a fencing version. These tests run several scanners at
 * once against one database and check what that guarantees.
 */
describe('competing ingestion workers', () => {
  for (const workers of [2, 3, 5]) {
    it(`${workers} scanners racing over the same chain apply every block exactly once`, async () => {
      const sb = await Sandbox.create({ traffic: 'random', seed: `race-${workers}`, batchSize: 2, confirmationDepth: 3 });
      sandboxes.push(sb);
      sb.chain.mine(60);

      // A scanner that loses too many races in a row ends its cycle (outcome stale_writer_limit) and the
      // next cycle starts fresh, so keep running rounds until the chain is fully ingested.
      const scanners = Array.from({ length: workers }, () => sb.newScanner());
      let blocksIngested = 0;
      const outcomes = new Set<string>();
      for (let round = 0; round < 10; round++) {
        const reports = await Promise.all(scanners.map((s) => s.scanOnce('startup')));
        for (const r of reports) {
          blocksIngested += r.blocksIngested;
          outcomes.add(r.outcome);
        }
        if ((await sb.checkpoint()).number === 60) break;
      }

      // Each of the 61 blocks (genesis included) was ingested by exactly one writer.
      expect(blocksIngested).toBe(61);
      expect([...outcomes].every((o) => o === 'caught_up' || o === 'stale_writer_limit')).toBe(true);

      expect(await sb.checkpoint()).toMatchObject({ number: 60, hash: sb.chain.head.hash });
      expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
      expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));
      expect((await sb.events()).every((e) => e.seenCount === 1)).toBe(true); // no event was written twice
      expect(await sb.count('event_audit', "action = 'duplicate_sighting'")).toBe(0);
      expect((await sb.invariants()).ok).toBe(true);
    });
  }

  it('records the races it lost: losers abort on the fencing version and start over from stored state', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'race-evidence', batchSize: 1, confirmationDepth: 3 });
    sandboxes.push(sb);
    sb.chain.mine(40);
    const reports = await Promise.all(Array.from({ length: 4 }, () => sb.newScanner().scanOnce('startup')));
    const aborts = reports.reduce((sum, r) => sum + r.staleWriterAborts, 0);
    expect(aborts).toBeGreaterThan(0);
    expect(sb.logs.count('writer.stale')).toBe(aborts);
    expect(reports.reduce((sum, r) => sum + r.blocksIngested, 0)).toBe(41);
  });

  it('two scanners racing while the chain reorganizes still converge on one canonical chain', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'race-reorg', batchSize: 3, confirmationDepth: 3 });
    sandboxes.push(sb);
    sb.chain.mine(30);
    await sb.scanner.scanOnce('startup');

    sb.chain.reorg({ depth: 4, replacement: 6, branch: 'R' });
    const reports = await Promise.all([sb.newScanner().scanOnce('notification'), sb.newScanner().scanOnce('notification')]);

    expect(reports.reduce((sum, r) => sum + r.reorgs, 0)).toBe(1); // the correction happened once, whoever did it
    expect(await sb.checkpoint()).toMatchObject({ number: sb.chain.head.number, hash: sb.chain.head.hash });
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect(await sb.count('recovery_log', "kind = 'reorg'")).toBe(1);
    expect((await sb.invariants()).ok).toBe(true);
  });
});

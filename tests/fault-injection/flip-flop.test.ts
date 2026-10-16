import { afterEach, describe, expect, it } from 'vitest';
import type { HeadRef } from '../../src/domain/types.js';
import type { BlockSpec } from '../../src/fixtures/chain.js';
import { mulberry32 } from '../../src/fixtures/prng.js';
import { block, transfer, tx } from '../../scenarios/builders.js';
import { Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows } from '../../scenarios/oracle.js';

/**
 * Seeded random walks over a chain that keeps changing its mind: blocks are mined, replaced by competing
 * branches (sometimes re-including the same transactions), and earlier branches come back, while scans and
 * deliveries happen at arbitrary moments - including several chain changes between two scans.
 *
 * The oracle is deliberately crude and independent of the notification code: a downstream system that only
 * counts ("+1 for every confirmation, -1 for every retraction") must, once everything has settled, hold +1
 * for exactly the high-value events that are on the fixture's canonical chain at least `depth` blocks below
 * its head, and 0 for every other event it was ever told about. The fixture knows which those are; the
 * notification code does not.
 */

const DEPTH = 2;
const STEPS = 20;
const SEEDS = 16;
const ACCOUNTS = ['alice', 'bob', 'carol', 'dave', 'erin'] as const;
const HIGH_USDX = ['20000', '15000', '12000'] as const; // threshold 10,000 USDX
const LOW_USDX = '10';

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});

describe('a chain that flip-flops: what downstream has been told always adds up', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: +1 per confirmation and -1 per retraction leaves exactly the live events, and every invariant holds`, async () => {
      const rng = mulberry32(seed * 104_729);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
      const sb = await Sandbox.create({ seed: `flip-${seed}`, confirmationDepth: DEPTH, batchSize: 1 + Math.floor(rng() * 5), maxReorgDepth: 100 });
      sandboxes.push(sb);

      let txCounter = 0;
      const spec = (): BlockSpec | undefined => {
        const r = rng();
        if (r < 0.4) {
          const from = pick(ACCOUNTS);
          const to = pick(ACCOUNTS.filter((a) => a !== from));
          return block(tx(transfer('USDX', from, to, pick(HIGH_USDX)), `T${seed}-${txCounter++}`));
        }
        if (r < 0.55) return block(tx(transfer('USDX', 'bob', 'carol', LOW_USDX)));
        return undefined;
      };
      const specs = (n: number) => Array.from({ length: n }, spec);

      const queue = sb.memoryQueue();
      const publisher = sb.publisher(queue);
      const consumer = sb.consumer(queue);
      const deliver = async () => {
        await publisher.publishPending();
        await consumer.processBatch();
      };

      const tips: HeadRef[] = [];
      const remember = () => {
        if (!tips.some((t) => t.hash === sb.chain.head.hash)) tips.push(sb.chain.head);
      };

      const opening = 3 + Math.floor(rng() * 4);
      sb.chain.mine(opening, specs(opening));
      remember();
      await sb.scanner.scanOnce('startup');

      for (let step = 0; step < STEPS; step++) {
        const r = rng();
        const head = sb.chain.head.number;
        if (r < 0.25) {
          const n = 1 + Math.floor(rng() * 3);
          sb.chain.mine(n, specs(n));
        } else if (r < 0.55 && head > 2) {
          const depth = 1 + Math.floor(rng() * Math.min(4, head - 1));
          const replacement = 1 + Math.floor(rng() * 4);
          sb.chain.reorg({ depth, replacement, branch: `b${seed}-${step}`, reinclude: rng() < 0.4 ? 'all' : 'none', specs: specs(replacement) });
        } else {
          // A branch that was canonical before comes back. A tip that is still part of the canonical chain is
          // skipped: shortening a chain along its own branch is indistinguishable from a lagging provider.
          const comeBack = tips.filter((t) => sb.chain.getHeaderByNumber(t.number)?.hash !== t.hash);
          if (comeBack.length > 0) sb.chain.setCanonicalTip(pick(comeBack).hash);
          else sb.chain.mine(1, specs(1));
        }
        remember();
        if (rng() < 0.85) await sb.scanner.scanOnce('poll');
        if (rng() < 0.6) await deliver();
      }

      // Settle: a few blocks on top so the final head is unambiguous, then scan and deliver until nothing is left.
      sb.chain.mine(DEPTH + 1, specs(DEPTH + 1));
      for (let i = 0; i < 60; i++) {
        await sb.scanner.scanOnce('poll');
        const cp = await sb.checkpoint();
        if (cp.number === sb.chain.head.number && cp.hash === sb.chain.head.hash) break;
      }
      expect(await sb.checkpoint()).toMatchObject({ number: sb.chain.head.number, hash: sb.chain.head.hash });
      for (let i = 0; i < 20; i++) {
        const published = await publisher.publishPending();
        const consumed = await consumer.processBatch();
        if (published.selected === 0 && consumed.received === 0) break;
      }
      expect(await sb.count('outbox', "status IN ('pending', 'published')")).toBe(0);

      // The stored state agrees with the fixture, and every stored-state invariant (I10 and I12 among them) holds.
      expect((await sb.invariants()).checks.filter((c) => c.violations > 0)).toEqual([]);
      expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
      expect(await sb.flows()).toEqual(expectedFlows(sb.chain.expectedEvents()));

      // What downstream holds: +1 per confirmation, -1 per retraction, per event.
      const head = sb.chain.head.number;
      const live = new Set(sb.chain.expectedEvents().filter((e) => e.highValue && head - e.blockNumber >= DEPTH).map((e) => e.eventId));
      const { rows } = await sb.db.query<{ event_id: string; confirmations: number; retractions: number }>(
        `SELECT event_id,
                count(*) FILTER (WHERE notification_type = 'event_confirmed')::int AS confirmations,
                count(*) FILTER (WHERE notification_type = 'event_retracted')::int AS retractions
           FROM notification_sink WHERE chain_id = $1 GROUP BY event_id`,
        [sb.chainId],
      );
      const net = new Map(rows.map((r) => [r.event_id, r.confirmations - r.retractions]));
      const wrong = [...new Set([...net.keys(), ...live])]
        .filter((id) => (net.get(id) ?? 0) !== (live.has(id) ? 1 : 0))
        .map((id) => ({ id, held: net.get(id) ?? 0, shouldHold: live.has(id) ? 1 : 0 }));
      expect(wrong).toEqual([]);
    });
  }
});

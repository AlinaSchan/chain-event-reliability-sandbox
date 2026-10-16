import { afterEach, describe, expect, it } from 'vitest';
import type { HeadRef } from '../../src/domain/types.js';
import type { BlockSpec } from '../../src/fixtures/chain.js';
import type { FaultRule } from '../../src/fixtures/faults.js';
import { mulberry32 } from '../../src/fixtures/prng.js';
import { InjectedCrash, type CrashPointName } from '../../src/observability/failpoints.js';
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
 *
 * The "chaos" walks replay the same chain histories and add what production adds: provider faults, processes
 * dying at exact lines, a second scanner racing the first, and deliveries running while a reorganization is
 * being applied. Faults and crash points are removed before settling, so the end state is comparable.
 */

const DEPTH = 2;
const STEPS = 20;
const SEEDS = 16;
const ACCOUNTS = ['alice', 'bob', 'carol', 'dave', 'erin'] as const;
const HIGH_USDX = ['20000', '15000', '12000'] as const; // threshold 10,000 USDX
const LOW_USDX = '10';

const FAULT_METHODS = ['getHead', 'getHeader', 'getLogs'] as const;
const FAULT_ACTIONS = ['timeout', 'server_error', 'stale', 'duplicate_logs', 'lagging'] as const;
const CRASH_POINTS: readonly CrashPointName[] = [
  'scanner.before_commit',
  'scanner.after_commit',
  'publisher.after_publish_before_mark',
  'consumer.after_effect_before_ack',
];

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});

async function walk(seed: number, chaos: boolean): Promise<void> {
  const rng = mulberry32(seed * 104_729);
  const chaosRng = mulberry32(seed * 7_919 + 1); // separate stream: the chain history is the same with and without chaos
  const pick = <T>(items: readonly T[], r: () => number = rng): T => items[Math.floor(r() * items.length)]!;
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

  /** Runs operations concurrently. An injected crash is a process dying, which is expected; anything else is a failure. */
  const together = async (ops: Array<() => Promise<unknown>>) => {
    const results = await Promise.allSettled(ops.map((op) => op()));
    for (const result of results) {
      if (result.status === 'rejected' && !(result.reason instanceof InjectedCrash)) throw result.reason;
    }
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
    const scanNow = rng() < 0.85;
    const deliverNow = rng() < 0.6;

    if (!chaos) {
      if (scanNow) await sb.scanner.scanOnce('poll');
      if (deliverNow) await deliver();
      continue;
    }

    for (let i = chaosRng() < 0.5 ? 1 + Math.floor(chaosRng() * 2) : 0; i > 0; i--) {
      const rule: FaultRule = {
        method: pick(FAULT_METHODS, chaosRng),
        action: pick(FAULT_ACTIONS, chaosRng),
        times: 1 + Math.floor(chaosRng() * 2),
        skip: Math.floor(chaosRng() * 3),
        lagBlocks: 1 + Math.floor(chaosRng() * 4),
      };
      sb.provider.faults.add(rule);
    }
    if (chaosRng() < 0.35) sb.crash.arm(pick(CRASH_POINTS, chaosRng), { afterHits: Math.floor(chaosRng() * 2) });

    // Anything may overlap with anything: two scanners, and a delivery pass while a correction is being applied.
    const ops: Array<() => Promise<unknown>> = [];
    if (scanNow) ops.push(() => sb.scanner.scanOnce('poll'));
    if (scanNow && chaosRng() < 0.35) ops.push(() => sb.newScanner().scanOnce('poll')); // a second writer, as after a restart
    if (deliverNow) ops.push(deliver);
    await together(ops);
  }

  // Settle: no more faults, no more crashes, a few blocks on top so the final head is unambiguous, then scan and
  // deliver until nothing is left.
  sb.provider.faults.clear();
  sb.crash.disarmAll();
  sb.chain.mine(DEPTH + 1, specs(DEPTH + 1));
  const settler = chaos ? sb.newScanner() : sb.scanner;
  for (let i = 0; i < 60; i++) {
    await settler.scanOnce('poll');
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
  const net = new Map(rows.map((row) => [row.event_id, row.confirmations - row.retractions]));
  const wrong = [...new Set([...net.keys(), ...live])]
    .filter((id) => (net.get(id) ?? 0) !== (live.has(id) ? 1 : 0))
    .map((id) => ({ id, held: net.get(id) ?? 0, shouldHold: live.has(id) ? 1 : 0 }));
  expect(wrong).toEqual([]);
}

describe('a chain that flip-flops: what downstream has been told always adds up', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: +1 per confirmation and -1 per retraction leaves exactly the live events, and every invariant holds`, () => walk(seed, false));
  }
});

describe('the same histories under chaos: provider faults, crashes at exact lines, a second scanner, concurrent deliveries', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: downstream still adds up and every invariant holds once the faults are gone`, () => walk(seed, true));
  }
});

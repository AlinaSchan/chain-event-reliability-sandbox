import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { block, minePlan, transfer, tx } from '../../scenarios/builders.js';
import { databaseUrl, redisUrl, Sandbox } from '../../scenarios/harness.js';
import { diffCanonical, EMPTY_DIFF } from '../../scenarios/oracle.js';

/**
 * The in-process failpoints throw an exception where a crash would be. These tests do the real thing:
 * the worker runs in a separate OS process that SIGKILLs itself at the failpoint, so no code of ours
 * runs after that line - the database and Redis servers see a connection vanish mid-flight.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runChild(env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/crash-child.ts'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const sandboxes: Sandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((s) => s.destroy()));
});

describe('a scanner process killed with SIGKILL', () => {
  const scanner = (sb: Sandbox, extra: Record<string, string> = {}) =>
    runChild({ ROLE: 'scanner', SCHEMA: sb.schema, SEED: 'hard-kill', BLOCKS: '40', BATCH: '4', DEPTH: '3', ...extra });

  it('before COMMIT leaves no trace of the batch; a restarted process finishes with the state of an uninterrupted run', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'hard-kill', batchSize: 4, confirmationDepth: 3 });
    sandboxes.push(sb);
    sb.chain.mine(40);

    const killed = await scanner(sb, { KILL_POINT: 'scanner.before_commit', KILL_AFTER_HITS: '2' });
    expect(killed.stdout).toContain('KILL scanner.before_commit');
    expect(killed.stdout).not.toContain('COMPLETED');
    expect(killed.code === 0).toBe(false); // it did not exit cleanly
    expect(await sb.checkpoint()).toMatchObject({ number: 7 }); // two batches committed, the third died before COMMIT
    expect((await sb.canonicalBlocks()).map((b) => b.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Math.max(0, ...(await sb.events()).map((e) => e.blockNumber))).toBeLessThanOrEqual(7);
    expect((await sb.invariants()).ok).toBe(true);

    const restarted = await scanner(sb);
    expect(restarted.stdout).toContain('COMPLETED caught_up');
    expect(restarted.code).toBe(0);
    expect(await sb.checkpoint()).toMatchObject({ number: 40, hash: sb.chain.head.hash });
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect((await sb.events()).every((e) => e.seenCount === 1)).toBe(true);
    expect((await sb.invariants()).ok).toBe(true);

    // The control: the same chain, ingested in this process without any crash.
    const control = await Sandbox.create({ traffic: 'random', seed: 'hard-kill', batchSize: 4, confirmationDepth: 3 });
    sandboxes.push(control);
    control.chain.mine(40);
    await control.scanner.scanOnce('startup');
    expect(await sb.fingerprint()).toBe(await control.fingerprint());
  }, 90_000);

  it('right after COMMIT keeps the committed batch and its checkpoint', async () => {
    const sb = await Sandbox.create({ traffic: 'random', seed: 'hard-kill', batchSize: 4, confirmationDepth: 3 });
    sandboxes.push(sb);
    sb.chain.mine(40);

    const killed = await scanner(sb, { KILL_POINT: 'scanner.after_commit', KILL_AFTER_HITS: '1' });
    expect(killed.stdout).toContain('KILL scanner.after_commit');
    expect(await sb.checkpoint()).toMatchObject({ number: 7 }); // the batch whose COMMIT had just returned is durable
    const upTo7 = [...Array(8).keys()].map((n) => sb.chain.blockAt(n)!);
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents(upTo7))).toEqual(EMPTY_DIFF);

    expect((await scanner(sb)).stdout).toContain('COMPLETED caught_up');
    expect(diffCanonical(await sb.events(), sb.chain.expectedEvents())).toEqual(EMPTY_DIFF);
    expect((await sb.invariants()).ok).toBe(true);
  }, 90_000);
});

describe.skipIf(redisUrl() === undefined)('a consumer process killed with SIGKILL between its commit and its XACK (real Redis)', () => {
  it('leaves the message pending in Redis; the restarted consumer recognises it from PostgreSQL and acknowledges it', async () => {
    const sb = await Sandbox.create({ confirmationDepth: 2, batchSize: 5 });
    sandboxes.push(sb);
    minePlan(
      sb.chain,
      { 3: block(tx(transfer('USDX', 'alice', 'bob', '20000'))), 4: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))) },
      9,
    );
    await sb.scanner.scanOnce('startup');
    const queue = sb.redisQueue('notifications');
    await sb.publisher(queue).publishPending();

    const killed = await runChild({
      ROLE: 'consumer',
      SCHEMA: sb.schema,
      REDIS_URL: redisUrl() ?? '',
      STREAM_KEY: `${sb.redisPrefix}:notifications`,
      CONSUMER_NAME: 'worker-1',
      KILL_POINT: 'consumer.after_effect_before_ack',
      KILL_AFTER_HITS: '0',
    });
    expect(killed.stdout).toContain('KILL consumer.after_effect_before_ack');
    expect(killed.stdout).not.toContain('COMPLETED');

    expect(await sb.sinkCount()).toBe(1); // the first effect is durable...
    expect((await queue.pending()).count).toBe(2); // ...and Redis has acknowledged nothing

    const report = await sb.consumer(queue, 'worker-1').processBatch();
    expect(report).toMatchObject({ delivered: 1, duplicates: 1, acked: 2 });
    expect(await sb.sinkCount()).toBe(2);
    expect((await queue.pending()).count).toBe(0);
    expect((await sb.invariants()).ok).toBe(true);
  }, 90_000);
});

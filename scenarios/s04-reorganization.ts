import { block, minePlan, settlement, transfer, tx } from './builders.js';
import { diffCanonical, EMPTY_DIFF, expectedFlows } from './oracle.js';
import { short } from './context.js';
import type { ScenarioDefinition } from './types.js';

/**
 * Confirmation depth 3, so at head 14 the events in blocks <= 11 are confirmed:
 *   4  USDX  alice -> bob    20,000   high
 *   9  USDX  bob   -> carol  15,000   high
 *  11  WRAPX alice -> bob         6   high
 *  12  USDX  carol -> dave   12,000   high   (transaction "D")
 *  13  GOLDX alice -> dave      150   high
 *  14  USDX  dave  -> erin      100   low
 */
const PLAN = {
  4: block(tx(transfer('USDX', 'alice', 'bob', '20000'))),
  9: block(tx(transfer('USDX', 'bob', 'carol', '15000'))),
  11: block(tx(transfer('WRAPX', 'alice', 'bob', '6'))),
  12: block(tx(transfer('USDX', 'carol', 'dave', '12000'), 'D')),
  13: block(tx(transfer('GOLDX', 'alice', 'dave', '150'))),
  14: block(tx(transfer('USDX', 'dave', 'erin', '100'))),
};

export const s04: ScenarioDefinition = {
  id: 'S04',
  title: 'Chain reorganization',
  summary:
    'The tip of the chain is replaced by a competing branch. The scanner notices that the stored tip is no longer the provider\'s block, finds the last common ancestor, marks the abandoned blocks and their events orphaned (kept for audit), subtracts their effect from derived state, and applies the replacement branch - all in one transaction. A reorganization below the confirmation depth is corrected but escalated to a human; one beyond the rollback limit halts the scanner instead of guessing.',
  fixture:
    'seed "S04", scripted traffic, head 14, confirmation depth 3, max automatic rollback 10. Six events (see the table in the demo); transaction "D" in block 12 is re-included in the replacement branch.',
  faults: [
    'Shallow: blocks 12-14 are replaced by four blocks of a competing branch; transaction D reappears in the new block 13 and a SETTLE 300,000 event appears in the new block 14.',
    'Deep: blocks 8-15 are replaced, which orphans events that had already reached the confirmation depth.',
    'Unrecoverable: a 12-block reorganization against a rollback limit of 10.',
  ],
  expected: [
    'Orphaned events stop counting as canonical; replacement events are processed; the same transaction in the new block is a new event.',
    'Totals and alerts are corrected, and the correction leaves audit rows and a recovery_log entry.',
    'Running the correction again changes nothing.',
    'A reorganization that orphans confirmed events opens a critical incident that requires manual review.',
    'Beyond the rollback limit the scanner halts with diagnostics and writes nothing.',
  ],
  acceptance: 'Orphaned events are no longer counted as canonical, and replacement events are processed.',
  evidence: [
    'recovery_log row kind=reorg (common ancestor, depth, orphaned counts); GET /status -> lastRecoveryAction',
    'event_audit rows with action orphaned; chain_blocks.orphan_reason; GET /events/:id',
    'incidents confirmed_event_orphaned and scanner_halted; scanner_checkpoints.status_detail with the probe list; GET /status -> openIncidents',
    'log events reorg.detected, reorg.applied, scanner.halted',
  ],
  requires: ['postgres'],
  sandbox: { seed: 'S04', traffic: 'scripted', confirmationDepth: 3, maxReorgDepth: 10, batchSize: 5 },
  checks: [
    { id: 'orphaned-events-not-canonical', description: 'The three events of the abandoned blocks are orphaned and the stored canonical events equal the fixture\'s new canonical events exactly.' },
    { id: 'replacement-events-processed', description: 'Events of the replacement branch are stored as provisional; the re-included transaction is a new event with a different identity.' },
    { id: 'derived-state-corrected', description: 'Account totals equal an independent fold over the new canonical chain; the orphaned events\' alerts are withdrawn and the new ones opened.' },
    { id: 'audit-record-created', description: 'recovery_log records the reorganization (ancestor, depth, counts) and each orphaned event has an orphaned audit row.' },
    { id: 'correction-is-idempotent', description: 'Scanning again and replaying the whole range leaves the logical state unchanged.' },
    { id: 'deep-reorg-flags-manual-review', description: 'Orphaning events that had reached the confirmation depth opens a critical incident requiring manual review, and their undelivered notifications are suppressed.' },
    { id: 'unrecoverable-reorg-halts-with-diagnostics', description: 'A reorganization deeper than the rollback limit halts the scanner with diagnostics and an open incident, and changes no data.' },
    { id: 'invariants-hold', description: 'Every stored-state invariant holds at the end, including while halted.' },
  ],
  async run(ctx) {
    const sb = ctx.sandbox;

    ctx.stage('fixture', 'Deterministic fixture chain (seed "S04"): 14 blocks, six events, confirmation depth 3.');
    minePlan(sb.chain, PLAN, 14);

    ctx.stage('baseline', 'Baseline ingestion: the scanner stores the canonical chain and its events.');
    await sb.scanner.scanOnce('startup');
    ctx.table('Canonical events', await ctx.eventRows());
    ctx.note('state before the reorganization', await sb.snapshot());
    const oldD = (await sb.events()).find((e) => e.blockNumber === 12)!;

    ctx.stage('fault', 'A competing branch replaces blocks 12-14 with four new blocks; transaction D is re-included, a settlement is added.');
    const { ancestor, removed, added } = sb.chain.reorg({
      depth: 3,
      replacement: 4,
      branch: 'B',
      specs: [undefined, block(tx(transfer('USDX', 'carol', 'dave', '12000'), 'D')), block(tx(settlement('erin', '300000'))), undefined],
    });
    ctx.table('Branch change', [
      ...removed.map((b) => ({ branch: 'A (abandoned)', block: b.header.number, hash: short(b.header.hash) })),
      ...added.map((b) => ({ branch: 'B (new)', block: b.header.number, hash: short(b.header.hash) })),
    ]);

    ctx.stage('problem', 'The stored tip is no longer the provider\'s block at that height; parent hashes no longer link.');
    const storedAt12 = (await sb.canonicalBlocks()).find((b) => b.number === 12)?.hash;
    ctx.note('block 12', { stored: short(storedAt12), provider: short(sb.chain.blockAt(12)?.header.hash), commonAncestor: ancestor.number });

    ctx.stage('recovery', 'The scanner finds the common ancestor, orphans the abandoned branch and applies the replacement in one transaction.');
    const report = await sb.scanner.scanOnce('notification');
    ctx.note('scan report', { outcome: report.outcome, reorgs: report.reorgs, blocksIngested: report.blocksIngested });
    ctx.table('Canonical events after recovery', await ctx.eventRows());
    ctx.table('Orphaned events (kept for audit)', (await ctx.eventRows({ includeOrphaned: true })).filter((r) => r.status === 'orphaned'));

    const events = await sb.events();
    const expected = sb.chain.expectedEvents();
    const orphanedBlocks = events.filter((e) => e.status === 'orphaned').map((e) => e.blockNumber);
    ctx.check(
      'orphaned-events-not-canonical',
      { orphanedBlocks, canonicalDiff: diffCanonical(events, expected), canonicalCount: events.filter((e) => e.status !== 'orphaned').length },
      { orphanedBlocks: [12, 13, 14], canonicalDiff: EMPTY_DIFF, canonicalCount: expected.length },
    );
    const newD = events.find((e) => e.status !== 'orphaned' && e.blockNumber === 13 && e.kind === 'erc20_transfer');
    const settle = events.find((e) => e.kind === 'settlement_recorded');
    ctx.check(
      'replacement-events-processed',
      {
        reincludedTransaction: newD?.status,
        differentIdentityFromTheOrphanedOne: newD !== undefined && newD.eventId !== oldD.eventId,
        newSettlement: settle?.status,
      },
      { reincludedTransaction: 'provisional', differentIdentityFromTheOrphanedOne: true, newSettlement: 'provisional' },
    );
    ctx.check(
      'derived-state-corrected',
      { flows: await sb.flows(), alerts: await sb.alerts() },
      { flows: expectedFlows(expected), alerts: { open: 5, withdrawn: 2 } },
    );
    const { rows: reorgLog } = await sb.db.query<{ from_block: number; to_block: number; details: { depth: number; commonAncestor: { number: number }; orphanedEvents: number } }>(
      "SELECT from_block, to_block, details FROM recovery_log WHERE kind = 'reorg'",
    );
    const orphanAudit = await sb.count('event_audit', "action = 'orphaned' AND to_state = 'orphaned'");
    ctx.check(
      'audit-record-created',
      { reorgEntries: reorgLog.length, depth: reorgLog[0]?.details.depth, ancestor: reorgLog[0]?.details.commonAncestor.number, orphanedEvents: reorgLog[0]?.details.orphanedEvents, orphanAuditRows: orphanAudit, logLine: sb.logs.count('reorg.applied') },
      { reorgEntries: 1, depth: 3, ancestor: 11, orphanedEvents: 3, orphanAuditRows: 3, logLine: 1 },
    );

    ctx.stage('recovery', 'Running the correction again, and replaying the whole range, must change nothing.');
    const settled = await sb.fingerprint();
    await sb.scanner.scanOnce('poll');
    await sb.newScanner().replayRange(0, sb.chain.head.number);
    ctx.check('correction-is-idempotent', { unchanged: (await sb.fingerprint()) === settled, reorgEntries: await sb.count('recovery_log', "kind = 'reorg'") }, { unchanged: true, reorgEntries: 1 });

    ctx.stage('fault', 'A deeper reorganization: blocks 8-15 are replaced. Events at blocks 9 and 11 had already reached the confirmation depth.');
    sb.chain.reorg({ depth: 8, replacement: 9, branch: 'C' });
    await sb.scanner.scanOnce('notification');
    const { rows: incidents } = await sb.db.query<{ kind: string; severity: string; requires_manual_review: boolean; status: string }>(
      "SELECT kind, severity, requires_manual_review, status FROM incidents WHERE kind = 'confirmed_event_orphaned'",
    );
    const suppressed = (await sb.outbox()).filter((o) => o.status === 'suppressed').length;
    ctx.table('Incidents', incidents);
    ctx.check(
      'deep-reorg-flags-manual-review',
      { incidents, suppressedNotifications: suppressed },
      { incidents: [{ kind: 'confirmed_event_orphaned', severity: 'critical', requires_manual_review: true, status: 'open' }], suppressedNotifications: 2 },
    );

    ctx.stage('fault', 'An unrecoverable reorganization: 12 blocks replaced, but the automatic rollback limit is 10.');
    const beforeHalt = await sb.fingerprint();
    sb.chain.reorg({ depth: 12, replacement: 13, branch: 'D' });
    const halted = await sb.scanner.scanOnce('notification');
    const cp = await sb.checkpoint();
    const { rows: detail } = await sb.db.query<{ status_detail: { reason: string; maxReorgDepth: number; storedTip: { number: number }; providerHead: { number: number }; searchedDownTo: number; probes?: unknown } }>(
      'SELECT status_detail FROM scanner_checkpoints',
    );
    const { probes: _probes, ...diagnostics } = (detail[0]?.status_detail ?? {}) as Record<string, unknown>;
    ctx.note('halt diagnostics (the per-height probes are stored too)', diagnostics);
    ctx.check(
      'unrecoverable-reorg-halts-with-diagnostics',
      {
        outcome: halted.outcome,
        status: cp.status,
        reason: detail[0]?.status_detail.reason,
        maxReorgDepth: detail[0]?.status_detail.maxReorgDepth,
        searchedDownTo: detail[0]?.status_detail.searchedDownTo,
        openHaltIncidents: await sb.count('incidents', "kind = 'scanner_halted' AND status = 'open' AND requires_manual_review"),
        dataUnchanged: (await sb.fingerprint()) === beforeHalt,
      },
      {
        outcome: 'halted',
        status: 'halted',
        reason: 'no_common_ancestor_within_max_reorg_depth',
        maxReorgDepth: 10,
        searchedDownTo: 6,
        openHaltIncidents: 1,
        dataUnchanged: true,
      },
    );

    ctx.stage('final', 'The scanner is halted and waiting for a human; everything already stored is consistent.');
    ctx.note('final state', await sb.snapshot());
    ctx.ok('invariants-hold', (await sb.invariants()).ok, (await sb.invariants()).checks.filter((c) => c.violations > 0));
  },
};

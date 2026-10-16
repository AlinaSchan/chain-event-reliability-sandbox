# Failure scenarios S01-S09

> Generated from `scenarios/*.ts` by `npm run docs:scenarios`. Edit the scenario definitions, not this file;
> `tests/unit/docs.test.ts` fails if this file is stale.

Every scenario below is executable. It builds a deterministic fixture in an isolated PostgreSQL schema,
injects its faults, and evaluates a list of **declared checks**, each comparing an observed value with an
expectation derived independently of the code under test (the fixture's own record of what it emitted, or a
constant written down in advance).

## How a verdict is reached

- **PASSED** requires all three: the scenario ran to the end without an exception, every check it evaluated
  passed, and every check it *declared* was evaluated. A scenario that skips a check by accident is reported as
  FAILED ("declared checks were never evaluated"), not passed.
- **SKIPPED** means the scenario could not run (S03 and S07 need a real Redis and `REDIS_URL`). Skipped is never
  reported as passed, `npm run scenarios` exits non-zero on it unless `--allow-skipped` is given, and CI fails on it.
- Each run's checks and evidence are stored in `scenario_runs` and served by `GET /scenarios/:id`.

## Running

```bash
docker compose up -d --wait && npm run db:migrate   # PostgreSQL + Redis, schema
npm run scenarios                                   # all nine, one verdict per scenario
npm run scenarios -- --only S04,S05                 # some of them
npm run demo -- --scenario S04                      # one scenario, narrated step by step
npx vitest run tests/fault-injection/scenarios.test.ts   # the same nine, as tests
```

## Summary

| ID | Scenario | Needs Redis | Reproduce | Declared checks |
| --- | --- | :---: | --- | ---: |
| S01 | Missed notification | no | `npm run scenarios -- --only S01` | 7 |
| S02 | Duplicate delivery | no | `npm run scenarios -- --only S02` | 7 |
| S03 | Crash after database commit, before Redis ACK | yes | `npm run scenarios -- --only S03` | 6 |
| S04 | Chain reorganization | no | `npm run scenarios -- --only S04` | 8 |
| S05 | RPC timeouts and bad responses | no | `npm run scenarios -- --only S05` | 7 |
| S06 | Delayed confirmations | no | `npm run scenarios -- --only S06` | 5 |
| S07 | Outbox delivery failure | yes | `npm run scenarios -- --only S07` | 6 |
| S08 | Restart and replay | no | `npm run scenarios -- --only S08` | 7 |
| S09 | Value thresholds and token decimals | no | `npm run scenarios -- --only S09` | 6 |

## S01 - Missed notification

The head-notification stream drops while blocks keep arriving. The notification is only a hint, so when the connection returns the scanner compares the provider head with its durable checkpoint and backfills the whole gap from stored state. A second outage with no reconnect is caught by the safety-net poll.

**Acceptance criterion.** Range backfill recovers all canonical events in the test range.

**Deterministic fixture.** seed "S01", scripted traffic, 32 blocks. Events: USDX 20,000 (block 3), SETTLE 300,000 (12), GOLDX 150 (17), WRAPX 6 (25), USDX 10 (26), USDX 50,000 (28), GOLDX 99 (31). Confirmation depth 3, batch size 5.

**Fault injection**

- The notifier disconnects after block 9. Blocks 10-29 are mined while it is down; their notifications are lost (not buffered, not replayed).
- A second outage with no reconnect: blocks 30-32 arrive and nothing tells the worker.

**Expected behavior**

- While disconnected the checkpoint stays at 9 and the stored events are a strict subset of the canonical ones - the gap is real and observable.
- On reconnect the worker triggers a scan, finds head 29 vs checkpoint 9, and backfills 10-29 from the provider by block range.
- The backfill is recorded in recovery_log and in the structured log.
- With no reconnect at all, the periodic poll alone brings the checkpoint to the head.

**Observable evidence**

- recovery_log row kind=backfill (blocks 10-29), also GET /status -> lastRecoveryAction
- log events notifier.disconnected, notifier.connected, backfill.range
- GET /status while disconnected: checkpoint vs fixtureChainHead, lagBlocks

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `gap-opens-while-disconnected` | With notifications lost, the checkpoint stays behind the provider head and canonical events are missing from the database. |
| `reconnect-triggers-reconciliation` | The scan that closed the gap was triggered by the reconnect, not by a notification carrying data. |
| `all-canonical-events-recovered` | After backfill the stored canonical events equal the fixture's: none missing, none extra, amounts and blocks identical. |
| `checkpoint-equals-provider-head` | The checkpoint is at the provider head with the head's hash. |
| `backfill-recorded-as-evidence` | recovery_log has a backfill entry for blocks 10-29 and the log has a backfill.range line. |
| `poll-recovers-without-any-notification` | With the notifier down and no reconnect, a poll alone ingests the remaining blocks and their events. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S01` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S01` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S01"`
- related focused tests: `tests/unit/fixture.test.ts` (a notifier that drops heads never replays them); `tests/integration/ingestion.test.ts` (restart and incremental scans)

## S02 - Duplicate delivery

The same events reach the system many times over: the provider returns every log twice, the notifier repeats each head, an already-processed range is replayed, and two scanners race on the same blocks. Event identity (chain, block hash, transaction hash, log index) and a unique constraint make all of it collapse into one logical effect, with the repeats on the audit trail.

**Acceptance criterion.** One logical effect and a correct audit trail.

**Deterministic fixture.** seed "S02", scripted traffic, 8 blocks. USDX 20,000 (block 2); USDX 15,000 and GOLDX 150 from one transaction (block 3); WRAPX 7 (block 4). All four are high-value. Confirmation depth 2.

**Fault injection**

- getLogs returns every log twice for the whole run.
- The notifier delivers each head notification several times.
- Two scanners ingest the same blocks at the same time.
- The processed range 0-8 is replayed three times.

**Expected behavior**

- Four events, one row each; the two logs of the shared transaction stay two events.
- Derived totals equal the fold over those four events, not twice that.
- One alert and one confirmed-notification outbox row per event.
- Every repeat sighting is recorded; replays change no logical effect.

**Observable evidence**

- chain_events.seen_count above 1 and event_audit rows with action duplicate_sighting (GET /events/:id -> audit)
- log events writer.stale for the races a competing scanner lost
- GET /events and GET /alerts: exactly one row per event identity

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `one-row-per-event-identity` | Stored events equal the fixture's four events exactly; the shared-transaction logs are two events; no identity appears twice. |
| `derived-totals-not-doubled` | account_flows equals an independent fold over the four events. |
| `one-alert-and-one-notification-each` | Open alerts and confirmation outbox rows equal the number of high-value events. |
| `repeat-sightings-are-audited` | Each event was seen more than once, and the repeats are recorded as duplicate_sighting audit rows. |
| `concurrent-writers-apply-each-block-once` | Two scanners racing on one database ingested every block exactly once between them. |
| `replay-adds-nothing` | Three replays of the processed range insert nothing and leave the logical state byte-for-byte unchanged. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S02` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S02` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S02"`
- related focused tests: `tests/fault-injection/duplicates.test.ts`; `tests/fault-injection/concurrent-workers.test.ts`; `tests/unit/prepare-retry.test.ts` (duplicate logs in one response)

## S03 - Crash after database commit, before Redis ACK

A consumer commits a notification's effect to PostgreSQL and dies before sending XACK. Redis still lists the message as pending, so it comes back - to the restarted consumer, or to another one after the idle time. The outbox row is already settled, so the redelivery is recognised and only acknowledged: the notification is delivered exactly once in effect.

**Acceptance criterion.** A restart does not double the processing.

**Deterministic fixture.** seed "S03", scripted traffic, real Redis Streams. USDX 20,000 (block 3) and GOLDX 150 (block 4) are confirmed by head 9; USDX 12,000 (block 10) by head 15. Confirmation depth 2.

**Fault injection**

- Phase 1: consumer "worker-1" crashes after committing the first effect and before XACK (it had also received the second message).
- Phase 2: consumer "worker-1" crashes the same way for a later notification and never comes back; "worker-2" must take it over.

**Expected behavior**

- After the crash the sink has the first delivery and Redis shows both messages unacknowledged.
- A restarted worker-1 sees its own pending messages first: the committed one is acknowledged as a duplicate, the other is delivered.
- After the idle time worker-2 claims the abandoned message (XAUTOCLAIM), recognises it and acknowledges it.
- Nothing is delivered twice; nothing is left pending.

**Observable evidence**

- Redis XPENDING (unacknowledged count) next to the notification_sink row count at the moment of the crash
- outbox.duplicate_deliveries and log event consumer.duplicate for the redelivered message
- GET /events/:id -> notifications and deliveries: one delivery per notification

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `effect-committed-before-crash` | At the moment of the crash the first effect is durable in PostgreSQL while Redis still holds both messages as unacknowledged. |
| `restart-does-not-double-process` | The restarted consumer delivers the second notification once, only acknowledges the first, and the sink has exactly two rows. |
| `duplicate-recognised-from-the-database` | The redelivered message was recognised as a duplicate from the outbox row, and nothing remains pending in Redis. |
| `takeover-by-another-consumer-after-idle` | A different consumer claims the abandoned message only after the idle time and settles it as a duplicate. |
| `exactly-one-delivery-per-notification` | Every notification has exactly one sink row and one processed outbox row. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S03` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S03` - the same run, narrated
- needs `REDIS_URL` (see docker-compose.yml); without it this scenario is reported as skipped
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S03"`
- related focused tests: `tests/integration/outbox.test.ts` (against the in-process queue double); `tests/fault-injection/hard-kill.test.ts` (a consumer process killed with SIGKILL); `tests/integration/queue-contract.test.ts` (real Redis)

## S04 - Chain reorganization

The tip of the chain is replaced by a competing branch. The scanner notices that the stored tip is no longer the provider's block, finds the last common ancestor, marks the abandoned blocks and their events orphaned (kept for audit), subtracts their effect from derived state, and applies the replacement branch - all in one transaction. A reorganization below the confirmation depth is corrected but escalated to a human; one beyond the rollback limit halts the scanner instead of guessing.

**Acceptance criterion.** Orphaned events are no longer counted as canonical, and replacement events are processed.

**Deterministic fixture.** seed "S04", scripted traffic, head 14, confirmation depth 3, max automatic rollback 10. Six events (see the table in the demo); transaction "D" in block 12 is re-included in the replacement branch.

**Fault injection**

- Shallow: blocks 12-14 are replaced by four blocks of a competing branch; transaction D reappears in the new block 13 and a SETTLE 300,000 event appears in the new block 14.
- Deep: blocks 8-15 are replaced, which orphans events that had already reached the confirmation depth.
- Unrecoverable: a 12-block reorganization against a rollback limit of 10.

**Expected behavior**

- Orphaned events stop counting as canonical; replacement events are processed; the same transaction in the new block is a new event.
- Totals and alerts are corrected, and the correction leaves audit rows and a recovery_log entry.
- Running the correction again changes nothing.
- A reorganization that orphans confirmed events opens a critical incident that requires manual review.
- Beyond the rollback limit the scanner halts with diagnostics and writes nothing.

**Observable evidence**

- recovery_log row kind=reorg (common ancestor, depth, orphaned counts); GET /status -> lastRecoveryAction
- event_audit rows with action orphaned; chain_blocks.orphan_reason; GET /events/:id
- incidents confirmed_event_orphaned and scanner_halted; scanner_checkpoints.status_detail with the probe list; GET /status -> openIncidents
- log events reorg.detected, reorg.applied, scanner.halted

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `orphaned-events-not-canonical` | The three events of the abandoned blocks are orphaned and the stored canonical events equal the fixture's new canonical events exactly. |
| `replacement-events-processed` | Events of the replacement branch are stored as provisional; the re-included transaction is a new event with a different identity. |
| `derived-state-corrected` | Account totals equal an independent fold over the new canonical chain; the orphaned events' alerts are withdrawn and the new ones opened. |
| `audit-record-created` | recovery_log records the reorganization (ancestor, depth, counts) and each orphaned event has an orphaned audit row. |
| `correction-is-idempotent` | Scanning again and replaying the whole range leaves the logical state unchanged. |
| `deep-reorg-flags-manual-review` | Orphaning events that had reached the confirmation depth opens a critical incident requiring manual review, and their undelivered notifications are suppressed. |
| `unrecoverable-reorg-halts-with-diagnostics` | A reorganization deeper than the rollback limit halts the scanner with diagnostics and an open incident, and changes no data. |
| `invariants-hold` | Every stored-state invariant holds at the end, including while halted. |

**Executable**

- `npm run scenarios -- --only S04` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S04` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S04"`
- related focused tests: `tests/integration/reorg.test.ts`; `tests/integration/outbox.test.ts` (consumer/reorg interleaving); `tests/integration/api.test.ts` (reorg visible through the API)

## S05 - RPC timeouts and bad responses

The provider times out, errors for good, answers from a stale cache, lags behind the checkpoint, and returns logs that belong to a branch its own headers no longer describe. Retries are bounded; nothing is skipped; the checkpoint only ever moves together with committed data; a response that does not fit the chain is refused rather than written.

**Acceptance criterion.** Retry does not skip blocks or leave an incorrect checkpoint.

**Deterministic fixture.** seed "S05", seeded random traffic (about one event per block), 20 blocks first, then waves of 12, 2 and 5 more. Confirmation depth 3, batch size 5, up to 4 attempts per operation starting at 100 ms and doubling.

**Fault injection**

- getLogs times out three times in a row on the first range; a getHeader call fails twice in the second batch.
- getLogs starts failing permanently after the first batch of a wave (retries run out).
- getHead answers with a cached older response once, and lags three blocks behind once.
- getLogs answers from a cache that predates a reorganization of the requested range.

**Expected behavior**

- Transient errors are retried with doubling delays and then succeed; no block is skipped.
- When retries run out the cycle ends without writing beyond the last committed batch, the status becomes degraded, and the next healthy cycle recovers.
- A stale or lagging head neither moves the checkpoint backwards nor looks like a reorganization.
- Logs that do not belong to the headers' blocks are rejected (INCONSISTENT) and fetched again; nothing from the wrong branch is stored.

**Observable evidence**

- log events rpc.retry (operation, code, attempt, delay), rpc.exhausted, scanner.recovered, provider.behind
- scanner_checkpoints.scan_status (degraded, then ok); GET /status -> checkpoint.scanStatus
- the delays the scanner asked for (recorded, not slept)

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `transient-errors-retried-with-bounded-backoff` | Five injected transient errors cost exactly five retries with delays 100, 200, 400 ms and 100, 200 ms, and the scan completes. |
| `no-block-skipped-and-no-gap` | Canonical blocks are contiguous from genesis to the head and the stored events equal the fixture's. |
| `checkpoint-never-ahead-of-committed-data` | When retries run out, the checkpoint stops at the last fully committed batch, nothing beyond it is stored, and the status is degraded. |
| `degraded-then-recovered` | Once the provider answers again the same checkpoint continues to the head and the status returns to ok. |
| `stale-and-lagging-heads-ignored` | A stale head and a lagging head leave the checkpoint where it was and report no reorganization. |
| `inconsistent-response-rejected-then-retried` | Logs from the pre-reorg cache are rejected as INCONSISTENT, retried, and nothing from the old branch is stored - not even as orphaned. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S05` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S05` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S05"`
- related focused tests: `tests/fault-injection/rpc-faults.test.ts` (including a 12-seed fault fuzzer); `tests/unit/prepare-retry.test.ts`

## S06 - Delayed confirmations

New events are provisional. They become confirmed only when the configured number of blocks sits on top of them, measured against the durable checkpoint - not against the provider's head and not against the clock. A high-value event queues its downstream notification at that moment and not one block earlier.

**Acceptance criterion.** The status changes only when the configured depth is reached.

**Deterministic fixture.** seed "S06", scripted traffic. USDX 20,000 (high-value) in block 5, USDX 10 (low-value) in block 6. Confirmation depth 4. The head advances one block at a time.

**Fault injection**

- The head advances slowly, one block per scan, so every depth is observed.
- The head stalls: the scanner is polled ten times with nothing new.
- The provider races ahead by 20 blocks but every call to it fails.

**Expected behavior**

- Both events stay provisional until exactly four blocks sit on top of their block.
- The notification for the high-value event is queued at that block and not before; the low-value event never queues one.
- Polling a stalled head never confirms anything.
- A provider that is ahead but unreachable does not confirm anything either.

**Observable evidence**

- event_audit rows with action confirmed and details.blocksOnTop (GET /events/:id)
- outbox rows appear only in the confirming transaction (GET /alerts -> notification is null while provisional)
- the head-by-head status table printed by the demo

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `provisional-until-depth` | At heads 5-8 the high-value event is provisional and no notification exists. |
| `confirmed-at-exact-depth` | At head 9 (four blocks on top of block 5) the high-value event is confirmed and exactly one notification is queued; the low-value event is confirmed at head 10 and queues none. |
| `no-time-based-confirmation` | Ten polls of a stalled head change no event status. |
| `depth-from-checkpoint-not-provider-head` | With the provider 20 blocks ahead but unreachable, events stay provisional until the checkpoint itself reaches the depth. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S06` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S06` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S06"`
- related focused tests: `tests/integration/confirmations.test.ts`; `tests/unit/watchlist-lifecycle.test.ts` (the depth rule)

## S07 - Outbox delivery failure

Redis is unreachable when the database has already committed; the consumer is not running while messages pile up; the publisher dies after Redis accepted a message but before the row was marked; and Redis loses the stream outright. In every case the transactional outbox in PostgreSQL either completes the delivery or shows exactly what is blocked, and no notification takes effect twice.

**Acceptance criterion.** Durable records restore delivery without repeating a logical effect.

**Deterministic fixture.** seed "S07", scripted traffic, real Redis Streams. High-value events: USDX 20,000 (block 3), GOLDX 150 (4), USDX 30,000 (10), WRAPX 9 (16). Confirmation depth 2, scanned in four waves.

**Fault injection**

- Redis unreachable (connection refused) when the first two notifications are published.
- Consumer not running while the first two messages wait in the stream.
- Publisher crashes after XADD succeeded and before the outbox row was marked published.
- The stream and its consumer group are deleted from Redis after the fourth notification was published (restart without persistence).

**Expected behavior**

- Unreachable Redis leaves rows pending with the error recorded - a visible blocking state - and chain state is untouched.
- Messages wait in the stream; once a consumer starts it drains them.
- The crashed publisher's row is published again; the duplicate in the stream has no second effect.
- Rows that were published but produced no effect are re-queued from PostgreSQL and delivered.

**Observable evidence**

- outbox.status, last_error, publish_attempts, republish_count, duplicate_deliveries (GET /events/:id -> notifications)
- recovery_log row kind=outbox_requeue; log events outbox.publish_failed, outbox.requeued
- Redis stream length versus notification_sink row count

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `redis-down-leaves-outbox-pending-with-error` | With Redis unreachable the rows stay pending, the error is recorded on them, and the confirmed events are unaffected. |
| `consumer-down-messages-wait-then-drain` | With no consumer the messages wait in Redis and nothing is delivered; once a consumer runs, every waiting message is delivered once. |
| `publisher-crash-duplicate-has-no-second-effect` | After a publisher crash between XADD and marking, the stream holds a duplicate but the sink has one delivery for the notification. |
| `redis-data-loss-repaired-from-outbox` | After Redis loses the stream, published-but-unprocessed rows are visible, get re-queued from PostgreSQL, and are delivered. |
| `every-notification-delivered-exactly-once` | Four notifications, four processed outbox rows, four sink rows, each notification once. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S07` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S07` - the same run, narrated
- needs `REDIS_URL` (see docker-compose.yml); without it this scenario is reported as skipped
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S07"`
- related focused tests: `tests/integration/outbox.test.ts`; `tests/integration/queue-contract.test.ts`; `tests/fault-injection/hard-kill.test.ts`

## S08 - Restart and replay

The scanner process is killed in the middle of ingestion - once just before COMMIT, once just after - and restarted each time. It resumes from the checkpoint stored in PostgreSQL, loses nothing, repeats nothing, and ends in exactly the state of a control run that was never interrupted. A final replay of the whole range then finds nothing to do.

**Acceptance criterion.** All canonical events are recovered with no gaps and no duplicate effects.

**Deterministic fixture.** seed "S08", seeded random traffic, 60 blocks, confirmation depth 3, batch size 4 (so 16 batches). A second, identical sandbox ingests the same chain without interruption as the control.

**Fault injection**

- Crash 1: the process dies inside the third batch transaction, immediately before COMMIT.
- Crash 2: after restart, the process dies immediately after the COMMIT of the second batch it ran.

**Expected behavior**

- After crash 1 the database contains the first two batches and the checkpoint for them, and no trace of the third.
- After crash 2 the committed batch and its checkpoint are durable.
- Each restart logs and records the checkpoint it resumed from.
- The final state is identical to the uninterrupted control run: same events, statuses, totals, alerts, notifications and blocks.

**Observable evidence**

- recovery_log rows kind=resume with the checkpoint each restart used; log event scanner.resume
- the fingerprint comparison with the uninterrupted control run (a declared check, not just a printout)
- chain_events.seen_count = 1 for every event

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `crash-before-commit-leaves-no-partial-batch` | After a crash before COMMIT the checkpoint is at the end of the last committed batch and no block or event beyond it is stored. |
| `crash-after-commit-keeps-committed-batch` | After a crash right after COMMIT the batch and its checkpoint are durable, and the stored events are exactly the fixture's up to that block. |
| `resume-from-durable-checkpoint` | Each restart resumed from the checkpoint stored in PostgreSQL (7, then 15) and recorded it. |
| `final-state-equals-uninterrupted-run` | The final logical state is byte-for-byte the same as a control run that was never interrupted. |
| `no-gaps-no-duplicate-effects` | Canonical blocks are contiguous 0-60, stored events equal the fixture's, and no event was ever written twice. |
| `replay-after-restart-adds-nothing` | Replaying blocks 0-60 after the restarts inserts nothing and changes nothing. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S08` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S08` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S08"`
- related focused tests: `tests/integration/ingestion.test.ts` (crash before and after COMMIT); `tests/fault-injection/hard-kill.test.ts` (a scanner process killed with SIGKILL); `tests/integration/reorg.test.ts` (crash during a reorg correction)

## S09 - Value thresholds and token decimals

High-value detection compares integers in base units. Thresholds are written in whole token units and converted with each token's own decimals; amounts and sums above 2^53 (and up to uint256) stay exact. The boundary of every threshold - one unit below, exactly on, one unit above - is classified correctly, and a threshold that would need rounding is rejected at configuration time.

**Acceptance criterion.** Exact integer comparisons, no floating-point errors.

**Deterministic fixture.** seed "S09", scripted traffic. 16 events across four tokens with 0, 2, 6 and 18 decimals, each placed one base unit below, on, or above its threshold, plus zero-value, 2^53+1 and uint256-max amounts. No USD values: there is no price oracle.

**Fault injection**

- Amounts that a floating-point comparison cannot tell apart (WRAPX threshold +/- 1 wei, GOLDX 2^53+1).
- Thresholds in the configuration that cannot be represented exactly.

**Expected behavior**

- Every case is classified exactly: inclusive at the threshold, off by one unit either side.
- Alerts store the threshold in base units of their own token.
- Totals stay exact beyond 2^53 and beyond uint256.
- Inexact or malformed thresholds are rejected before anything runs.

**Observable evidence**

- alerts.threshold_units per token (GET /alerts -> thresholdUnits, threshold)
- the boundary table and the rejected-configurations table printed by the demo
- account_flows totals beyond 2^53 and beyond uint256

**Declared checks** (pass/fail assertions)

| Check | Asserts |
| --- | --- |
| `every-boundary-case-classified-exactly` | Each of the 16 cases has an open alert exactly when its amount is at or above its token's threshold. |
| `thresholds-stored-in-base-units-per-token` | The alerts carry 100, 10000000000, 25000050 and 5000000000000000000 as thresholds - one per token, in that token's base units. |
| `totals-exact-above-2^53-and-uint256` | Account totals equal an independent bigint fold, including a sum that exceeds uint256. |
| `float-comparison-would-misclassify` | The WRAPX threshold - 1 wei case is misclassified by a Number comparison and classified correctly by the integer one. |
| `config-rejects-inexact-thresholds` | Thresholds with too many fractional digits, exponents, signs or zero value are rejected with an explanation; nothing is rounded. |
| `invariants-hold` | Every stored-state invariant holds at the end. |

**Executable**

- `npm run scenarios -- --only S09` - verdict and failed checks with expected vs actual
- `npm run demo -- --scenario S09` - the same run, narrated
- `npx vitest run tests/fault-injection/scenarios.test.ts -t "S09"`
- related focused tests: `tests/fault-injection/thresholds.test.ts`; `tests/unit/units.test.ts`; `tests/unit/watchlist-lifecycle.test.ts`

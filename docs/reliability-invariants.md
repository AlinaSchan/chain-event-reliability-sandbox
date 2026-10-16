# Reliability invariants

Two kinds are listed: **stored-state invariants**, which can be re-derived from the database at any time
(`src/recovery/invariants.ts`, `GET /status?verify=true`, run after every scenario), and **design invariants**,
which are properties of the code paths and are verified by the tests named next to them.

## Stored-state invariants

Each is a SQL query that must return zero violations. They read only PostgreSQL and make no assumption about
how the state got there, so they are a check on the whole pipeline, not on one function.

| Id | Statement |
| --- | --- |
| `I1.checkpoint-is-canonical-tip` | The checkpoint points at the canonical block at its height, and no canonical block exists above it. |
| `I2.canonical-chain-linked-without-gaps` | Every canonical block (after the first) has the canonical block at height-1 as its parent. |
| `I3.event-status-follows-block` | Events in canonical blocks are provisional or confirmed; events in non-canonical blocks are orphaned. |
| `I4.no-confirmable-event-left-provisional` | No canonical provisional event sits at or below checkpoint - confirmation depth. |
| `I5.flows-equal-fold-over-non-orphaned-events` | `account_flows` equals a recomputation from the non-orphaned ERC-20 events. |
| `I6.alerts-follow-events` | Open alerts exist exactly for non-orphaned events; every high-value non-orphaned event has an open alert. |
| `I7.no-notification-queued-before-confirmation` | No confirmation notification exists for an event that never reached `confirmed`. |
| `I8.sink-matches-outbox` | Every processed outbox row has a sink delivery, and every sink delivery belongs to a processed row. |
| `I9.audit-trail-ends-in-current-status` | Each event's latest audit row ends in the status the event currently has. |
| `I10.delivered-then-orphaned-has-retraction` | A confirmation delivered for an event that is now orphaned has a retraction queued. |
| `I11.halt-has-open-incident` | A halted scanner always has an open incident explaining why. |

What the checker **cannot** see: an event that should be in the database and is not. Missing data leaves the state
internally consistent. That is what range replay is for (`Scanner.replayRange`): it re-reads a range from the
provider and inserts whatever is absent. `tests/fault-injection/duplicates.test.ts` ("heals a gap") demonstrates
both halves: the invariants hold with an event missing, and the replay finds and fills it.

## Design invariants

| # | Invariant | Enforced in | Verified by |
| --- | --- | --- | --- |
| D1 | **The checkpoint moves only with the data it describes.** Blocks, events, derived state and the new tip are committed together. | `applyBatch` (`src/ingestion/apply.ts`) | `tests/integration/ingestion.test.ts` (crash before / after COMMIT); `tests/fault-injection/hard-kill.test.ts` (real SIGKILL); S08 |
| D2 | **Writers are serialized by the database, not by assumption.** Row lock on the checkpoint plus a fencing version; a stale batch aborts. | `lockCheckpoint`, `StaleCheckpointError` (`src/storage/checkpoint.ts`) | `tests/fault-injection/concurrent-workers.test.ts` (2, 3 and 5 racing scanners, each block ingested exactly once) |
| D3 | **A notification never carries data.** It can cause a scan; ingestion reads block ranges from the provider and compares with stored state. | `ScannerWorker`, `Scanner.step` | S01 (20 lost notifications, full recovery; poll-only recovery) |
| D4 | **Repeat delivery has no second effect.** Events are insert-if-absent on identity; derived state and alerts follow the rows that statement actually changed. | `insertEvents` (`src/ingestion/apply.ts`) | S02; `tests/fault-injection/duplicates.test.ts`; unit tests for `prepareBlocks` |
| D5 | **Nothing derived from a non-canonical block survives a correction, and the correction is atomic and idempotent.** | `orphanCanonicalAbove` (`src/recovery/reorg.ts`) | `tests/integration/reorg.test.ts`; S04 |
| D6 | **No provider answer is used unless it is internally consistent.** Logs must match the headers' block hashes; transactions must belong to their block; headers must link. | `prepareBlocks` (`src/ingestion/prepare.ts`) | `tests/unit/prepare-retry.test.ts`; S05 |
| D7 | **Confirmation depth is measured from the checkpoint,** and confirmation is the only way a notification is created. Nothing is queued for a provisional event. | `confirmEligible` (`src/confirmation/confirm.ts`) | S06; invariant I7; `tests/integration/outbox.test.ts` ("never queues anything for an event that is still provisional") |
| D8 | **Redis is not a source of truth.** Delivery state lives in `outbox`; the consumer commits its effect before acknowledging; rows that were published but never took effect are re-queued. | `NotificationConsumer`, `OutboxPublisher` | S03; S07; `tests/integration/queue-contract.test.ts` (real Redis) |
| D9 | **Lock order is events -> outbox,** and the consumer holds a shared lock on the event while deciding, so a reorg cannot slip between its check and its commit. | `NotificationConsumer.applyEffect`, `orphanCanonicalAbove`, `confirmEligible` | `tests/integration/outbox.test.ts` (deterministic interleaving; removing the shared lock makes it fail) |
| D10 | **The scanner halts rather than guess.** No common ancestor within `MAX_REORG_DEPTH` -> no writes, diagnostics stored, incident opened. | `Scanner.findCommonAncestor`, `Scanner.halt` | `tests/integration/reorg.test.ts`; S04 |
| D11 | **Every correction is on the record.** `event_audit`, `recovery_log` and `incidents` are append-only in the code paths here; blocks and events are flagged, never deleted. | `src/storage/audit.ts`, `orphanCanonicalAbove` | S04 (`audit-record-created`, `deep-reorg-flags-manual-review`) |
| D12 | **Amounts are never floating point.** bigint end to end; `numeric` in the database; thresholds parsed as exact decimals and rejected if they would need rounding. | `src/domain/units.ts`, `watchlist.ts`, migrations | S09; `tests/unit/units.test.ts` |

## How the tests prove they can fail

A test that cannot fail proves nothing. Besides running the suites, key behaviors were checked by temporarily
breaking the code and confirming the right tests fail (derived-state reversal removed -> 8 reorg tests fail;
confirmation boundary `<=` -> `<` -> 5 fail; same-height tip check removed -> exactly the same-height test fails;
duplicate detection in the consumer removed -> 6 outbox tests fail; shared event lock removed from the consumer ->
the deterministic interleaving test fails). These were manual mutation checks; there is no mutation-testing job
in CI.

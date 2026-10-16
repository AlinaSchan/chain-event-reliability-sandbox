# Review guide

For an engineer reading the code before, or during, an agreed review. Reading this is not a request for changes:
nothing here asks for a pull request, a patch or unpaid work, and any written feedback is welcome but optional.
The questions at the end are the ones the author would most like a second pair of eyes on.

The repository is an independent sandbox for discussing scope. It is not an existing production backend and does
not belong to any client. All data is synthetic.

## Fifteen minutes

```bash
npm install
docker compose up -d --wait        # PostgreSQL 17 and Redis 7 on 127.0.0.1
npm run db:migrate
npm run demo                       # scenario S04 (reorganization), narrated, ~1 second
npm run scenarios                  # all nine failure scenarios, one verdict each
```

`npm run demo -- --list` shows the other scenarios; `--scenario S01` is the missed-notification story.
The demo output is the real run; its last lines are the scenario's own verdict.

## A reading order (about an hour)

| # | Read | What to look for |
| ---: | --- | --- |
| 1 | `docs/architecture.md`, the **transaction boundaries** table | Which operations share a transaction, and what the lock and fence are. Everything else follows from it. |
| 2 | `migrations/001_chain_state.sql` | The identity constraint and its `CHECK`, one canonical block per height (partial unique index), the non-negative `CHECK` on `account_flows` that turns a double reversal into a failed transaction. |
| 3 | `src/ingestion/apply.ts` - `applyBatch` | The single write path. The numbered comment lists the steps. Where `advanceCheckpoint` is relative to the inserts and to `crash?.hit`. |
| 4 | `src/ingestion/scanner.ts` - `step`, `handleReorg`, `findCommonAncestor`, `halt` | How a step decides between "forward", "reorg", "caught up", "provider behind" and "halt". |
| 5 | `src/recovery/reorg.ts` - `orphanCanonicalAbove` | The correction, statement by statement, and why each is idempotent. |
| 6 | `src/queue/consumer.ts`, `src/queue/publisher.ts` | Effect-then-ack ordering, the lock order, the re-queue of rows that never took effect. |
| 7 | `scenarios/s04-reorganization.ts`, `tests/integration/reorg.test.ts` | What is asserted, and against what independent expectation (`scenarios/oracle.ts`). |

## Where things are

| Question | Answer |
| --- | --- |
| Where is the key ingestion logic? | `Scanner.step` decides, `applyBatch` writes. Provider answers are validated in `prepareBlocks` first. |
| How is event identity implemented? | `src/domain/identity.ts` (`eventIdOf`); stored as the primary key and as a unique constraint on `(chain_id, block_hash, transaction_hash, log_index)`; inserted with `ON CONFLICT (event_id)` in `insertEvents`. Rules and edge cases: `docs/event-lifecycle.md`. |
| Where are checkpoints stored? | `scanner_checkpoints` in PostgreSQL (`src/storage/checkpoint.ts`): last block number and hash, scan status (`ok` / `degraded` / `halted`), a fencing `version`, `updated_at`. |
| Why is Redis not the source of truth? | Because a stream can lose its data. Delivery state is in the `outbox` table; the consumer commits its effect before XACK; rows that were published but never took effect are re-queued. S07 deletes the stream and shows recovery. |
| How does reorg detection work? | Each step compares the stored tip with the provider's block at that height (so a same-height replacement is seen before any new block), and checks that the next block's parent hash matches. A mismatch starts the common-ancestor walk. |
| How does restart recovery work? | There is no recovery code path to get wrong: a restarted scanner reads the checkpoint and carries on. The checkpoint only exists together with its data. A restart is logged and recorded (`scanner.resume`, `recovery_log` kind `resume`). |

## Invariants worth attacking

`docs/reliability-invariants.md` lists them. The ones most worth trying to falsify:

- **I1 / I2**: the checkpoint is the canonical tip and the canonical chain is linked without gaps.
- **I5**: `account_flows` equals a recomputation from non-orphaned events (this is the check that catches any
  double application or missed reversal).
- **I10 / I12**: a delivered confirmation that no longer describes its event always has a retraction of the same
  epoch queued (I10), and no retraction exists for a confirmation that was never delivered (I12). The pair is what
  keeps a downstream system that only counts `+1` / `-1` correct across flip-flopping reorganizations.
- D9: the consumer's shared lock on the event versus a concurrent reorg.

`GET /status?verify=true` runs all twelve on whatever database the service is using.

## Reproducing the important failures

```bash
npm run demo                                  # S04: reorg, deep reorg (incident), unrecoverable reorg (halt)
npm run demo -- --scenario S01                # missed notifications, reconnect backfill, poll-only recovery
npm run demo -- --scenario S03                # crash between database commit and XACK (needs Redis)
npx vitest run tests/fault-injection/hard-kill.test.ts       # workers killed with real SIGKILL
npx vitest run tests/integration/outbox.test.ts -t "deterministic interleaving"
```

To poke at the live service instead of the scenarios:

```bash
ADMIN_ENABLED=true ADMIN_TOKEN=local-only-token-0123456789 npm start       # loopback only
curl -s localhost:3000/status | head -c 600
curl -s -X POST localhost:3000/admin/fixture/reorg -H 'authorization: Bearer local-only-token-0123456789' \
     -H 'content-type: application/json' -d '{"depth":3,"replacement":4,"branch":"X"}'
curl -s localhost:3000/status | head -c 900          # lastRecoveryAction: kind "reorg"
```

## Trade-offs that are still open

These were decisions, not discoveries; each has a cost.

1. **`observed` is not persisted.** It is the decode-time state and the `from` side of the first audit row.
   Persisting it would need a notion of "event of an unattached block".
2. **Notification epochs come from `confirm_count`.** Simple and deterministic, but it couples notification identity
   to a counter on the event row.
3. **The publisher marks rows per batch,** not per row. A crash re-publishes at most one batch. Per-row transactions
   would narrow the window at the cost of round trips.
4. **READ COMMITTED plus explicit row locks** rather than SERIALIZABLE or advisory-lock leadership. It is explicit and
   cheap, and it makes extra writers wasteful rather than unsafe; the cost is that correctness lives in the lock order.
5. **`seen_count` and duplicate counters are history, not state.** They change on every replay. The fingerprint used in
   the scenarios excludes them on purpose.
6. **The scanner halts rather than guesses** when no ancestor is found within the limit. The alternative (roll back to
   genesis) is "recovery" that could silently discard a month of data.
7. **Confirmation by depth, not by finality tag.** Easy to reason about on a fixture; not what an operator of a real
   chain would stop at.

## Review questions

Each points at where to look and at what is already known.

1. **Is checkpoint advancement correctly coupled to durable event persistence?**
   Look at `applyBatch`: the checkpoint update, the inserts and the confirmation sweep share one transaction behind
   the checkpoint row lock. Is there any path (the reorg path, replay, `halt`, a retry) where a write happens
   outside it, or where the tip could move without its blocks?
2. **Can replay or consumer redelivery create duplicate logical effects?**
   `insertEvents` derives projection and alert changes from `RETURNING`, and `applyEffect` checks the outbox row under
   a lock. Is there an input for which the same effect is applied twice - for example a payload that changes between
   deliveries, or two notifications with different epochs for one confirmation?
3. **Does the reorganization procedure handle canonical-state corrections consistently?**
   `orphanCanonicalAbove` subtracts derived state from the *stored* decoded values and flips alerts and outbox rows.
   Consider a block that is orphaned, restored, and orphaned again; an event whose alert was judged against an older
   threshold; a replacement branch that shares transactions with the abandoned one.
4. **What happens if Redis becomes unavailable after a successful database commit?**
   Rows stay `pending` with `last_error`, `GET /status` shows the backlog and its age, and recovery needs no operator.
   Is the signal loud enough? Is `republishAfterMs` a sensible way to detect a lost message, or does it risk duplicate
   storms under a slow consumer?
5. **Which failure could still cause a silent event gap?**
   The candidates the author knows: a provider that returns *fewer logs than exist* for a range while its headers are
   consistent (nothing here cross-checks against a logs bloom or a second provider); a watchlist that omits a
   contract; pruned history. Replay heals gaps once someone looks; nothing detects one automatically. Are there others?
6. **Are event identity and notification identity appropriately separated?**
   `eventId` names an occurrence in a block; `notificationId` names one delivery of one fact about that occurrence
   (`#type#epoch`). Is the epoch derivation robust across orphan / restore / re-confirm cycles?
7. **Which recovery assumptions would need to change for a real multi-provider deployment?**
   Heads and headers from different providers can disagree transiently; "common ancestor" needs a definition across
   sources; retries and back-off need jitter; a provider that is behind is currently harmless but an adversarial one
   is not considered. What would you change first?

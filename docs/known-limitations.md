# Known limitations

Stated plainly, so that review time goes to the things that matter. Nothing here is hidden elsewhere in the code.

## What this is not

- **Not a production system and not measured for performance.** No throughput, latency or uptime figure is
  produced or claimed. Batches are small and statements are plain SQL.
- **Not connected to any network.** Chains, blocks, hashes and addresses come from a seeded generator. Block
  hashes are `keccak256` over a header layout of this project's own, not Ethereum's; addresses are hashes of labels
  and belong to nobody.
- **No keys, wallets, signing, custody, trading, USD valuation or transaction submission** - by design.

## Scope of the model

- **One provider.** There is no quorum, cross-checking or failover between providers. A provider that returns a
  consistent but wrong chain is believed. A multi-provider deployment would have to decide how to compare heads,
  how to treat disagreement, and what "common ancestor" means across sources (see the review questions).
- **Confirmation is by depth only.** `safe` / `finalized` block tags are not read. The depth is a configured
  heuristic; the system's answer to a deeper reorganization is to correct itself, raise an incident and (for
  delivered notifications) queue a retraction. It cannot reverse what a downstream system did with a confirmation.
- **One chain per configuration.** Every table is keyed by `chain_id`, but `src/app/runtime.ts` wires a single
  chain and one stream. Running several means several processes.
- **Native-value transfers and internal (trace) transfers are not implemented.** The identity rule that would be used
  is written down in `docs/event-lifecycle.md`.
- **The watchlist is static configuration.** Changing a threshold does not retroactively change alerts already stored;
  they keep the threshold they were judged against.
- **`startBlock` is a trust anchor.** The block at the configured start has its parent unverified.

## Delivery

- **Delivery is at-least-once and unordered.** Effects are idempotent, but notifications for different events can
  arrive in any order.
- **No poison-message handling.** A message whose handler keeps failing stays pending and is retried every pass;
  there is no delivery cap and no dead-letter stream. It is visible (`GET /status` -> unacknowledged count, the
  `consumer.failed` log event) but not removed.
- **The sink is a table, not a webhook.** It models a downstream system that deduplicates on the notification id. A
  real HTTP receiver would need that idempotency key and its own retry semantics; this project does not call any
  external endpoint.
- **The Redis stream is never trimmed.** Acknowledged entries accumulate. A deployment would trim by minimum id.
- **Redis restart is simulated, not performed.** Tests delete the stream and its consumer group (what a restart without
  persistence does to this application) and kill worker processes with SIGKILL. Restarting a Redis container
  mid-test is not automated.
- **Requires Redis >= 6.2** (`XAUTOCLAIM`). `docker-compose.yml` uses Redis 7.

## Operations

- **No pruning or partitioning.** `chain_blocks`, `event_audit` and `outbox` grow without bound.
- **Retry has no jitter and there is no circuit breaker,** to keep scenarios deterministic. Several processes retrying
  the same provider in lock-step would want both.
- **Operator tooling is minimal.** `unhalt` clears a halt with a note; there is no tool to resolve a
  `payload_mismatch`, to re-drive a single notification, or to roll the checkpoint back by hand except with SQL.
- **The API has no authentication for read routes** and no TLS. It binds to loopback by default and logs a warning
  if told otherwise. Admin routes refuse to start off loopback.
- **Clock use.** Block timestamps come from the fixture. Audit timestamps and the age threshold for re-queueing use
  the database clock.
- **PostgreSQL failover and replication lag are not modeled.** Transactions run at READ COMMITTED and rely on
  explicit row locks, which assumes a single primary.

## Verification

- Redis-backed tests (the contract tests against real Redis, scenarios S03 and S07, the consumer SIGKILL test) were
  executed in GitHub Actions on Linux with Redis 7. The development machine used for most of the work had no Docker,
  so on that machine those tests are skipped and reported as skipped; the PostgreSQL-backed tests ran there against
  PostgreSQL 17 on Windows.
- Mutation checks were manual (see `docs/reliability-invariants.md`).
- The fault fuzzer uses 12 fixed seeds; it is a regression net, not an exhaustive search.
- A deadlock between the consumer and a reorg is prevented by lock ordering and covered by one deterministic
  interleaving test plus a 10-round randomized one; other interleavings were reasoned about, not enumerated.

-- Durable chain state: scanner checkpoint, block history, events, audit trail and derived state.
-- PostgreSQL is the source of truth for all of it. Amounts are exact `numeric` base units (never float).

CREATE TABLE scanner_checkpoints (
  chain_id          bigint PRIMARY KEY,
  start_block       bigint NOT NULL,
  -- Highest block whose block row, events and derived state are all committed.
  -- start_block - 1 with a NULL hash means "nothing ingested yet".
  last_block_number bigint NOT NULL,
  last_block_hash   text,
  -- ok: healthy. degraded: the last cycle ended on RPC trouble, state is untouched.
  -- halted: automatic recovery is not safe; a human has to look (see incidents / recovery_log).
  scan_status       text NOT NULL DEFAULT 'ok' CHECK (scan_status IN ('ok', 'degraded', 'halted')),
  status_detail     jsonb,
  -- Fencing token. Bumped by every commit that moves the tip; writers compare-and-swap on it.
  version           bigint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkpoint_hash_matches_progress CHECK ((last_block_hash IS NULL) = (last_block_number < start_block))
);

CREATE TABLE chain_blocks (
  chain_id        bigint NOT NULL,
  block_hash      text NOT NULL,
  block_number    bigint NOT NULL,
  parent_hash     text NOT NULL,
  block_timestamp timestamptz NOT NULL,
  tx_count        integer NOT NULL,
  -- Blocks are never deleted. A block that leaves the canonical chain is flagged, with the reason.
  canonical       boolean NOT NULL DEFAULT true,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  orphaned_at     timestamptz,
  orphan_reason   text,
  PRIMARY KEY (chain_id, block_hash)
);
-- At most one canonical block per height: a second one is a bug and fails loudly.
CREATE UNIQUE INDEX chain_blocks_one_canonical_per_height ON chain_blocks (chain_id, block_number) WHERE canonical;
CREATE INDEX chain_blocks_by_number ON chain_blocks (chain_id, block_number);

CREATE TABLE chain_events (
  event_id          text PRIMARY KEY,
  chain_id          bigint NOT NULL,
  block_hash        text NOT NULL,
  transaction_hash  text NOT NULL,
  log_index         integer NOT NULL,
  block_number      bigint NOT NULL,
  contract_address  text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('erc20_transfer', 'settlement_recorded')),
  decoded           jsonb NOT NULL,
  amount            numeric NOT NULL CHECK (amount >= 0 AND amount < 115792089237316195423570985008687907853269984665640564039457584007913129639936),
  -- Hash of the raw log. Two different payloads under one identity are an integrity incident.
  payload_hash      text NOT NULL,
  status            text NOT NULL CHECK (status IN ('provisional', 'confirmed', 'orphaned')),
  status_reason     text NOT NULL,
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- Times this event reached `confirmed`. Notification identity is derived from it.
  confirm_count     integer NOT NULL DEFAULT 0,
  -- Sightings of this identity, including the first. More than one means duplicate delivery.
  seen_count        integer NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  -- The identity: same occurrence -> same row; same tx in a different block -> a new row.
  CONSTRAINT chain_events_identity UNIQUE (chain_id, block_hash, transaction_hash, log_index),
  CONSTRAINT chain_events_id_matches_identity
    CHECK (event_id = chain_id::text || ':' || block_hash || ':' || transaction_hash || ':' || log_index::text),
  FOREIGN KEY (chain_id, block_hash) REFERENCES chain_blocks (chain_id, block_hash)
);
CREATE INDEX chain_events_by_status ON chain_events (chain_id, status, block_number);
CREATE INDEX chain_events_by_block ON chain_events (chain_id, block_hash);
CREATE INDEX chain_events_by_tx ON chain_events (chain_id, transaction_hash);

-- Append-only history of everything that happened to an event, including sightings that changed nothing.
CREATE TABLE event_audit (
  id         bigserial PRIMARY KEY,
  chain_id   bigint NOT NULL,
  event_id   text NOT NULL REFERENCES chain_events (event_id),
  action     text NOT NULL CHECK (action IN ('ingested', 'duplicate_sighting', 'confirmed', 'orphaned', 'reactivated', 'payload_mismatch')),
  -- 'observed' appears here as the from-state of the first transition; it is never a stored status.
  from_state text,
  to_state   text,
  reason     text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_audit_by_event ON event_audit (event_id, id);

-- Logs from a watched contract that look like a tracked event but do not decode. Kept, never dropped.
CREATE TABLE quarantined_logs (
  id               bigserial PRIMARY KEY,
  chain_id         bigint NOT NULL,
  block_hash       text NOT NULL,
  transaction_hash text NOT NULL,
  log_index        integer NOT NULL,
  block_number     bigint NOT NULL,
  contract_address text NOT NULL,
  reason           text NOT NULL,
  raw              jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, block_hash, transaction_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES chain_blocks (chain_id, block_hash)
);

-- Derived state: running inbound/outbound totals per token and account, over non-orphaned ERC-20 events.
-- Invariant (checked in src/recovery/invariants.ts): equals a fold over those events.
CREATE TABLE account_flows (
  chain_id       bigint NOT NULL,
  token_address  text NOT NULL,
  account        text NOT NULL,
  inbound        numeric NOT NULL DEFAULT 0,
  outbound       numeric NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, token_address, account),
  -- A double reversal would push a total negative; the constraint turns that bug into a failed transaction.
  CONSTRAINT account_flows_non_negative CHECK (inbound >= 0 AND outbound >= 0)
);

-- Derived state: one alert per high-value event. Follows the event: withdrawn when it is orphaned.
CREATE TABLE alerts (
  alert_id         text PRIMARY KEY,
  chain_id         bigint NOT NULL,
  event_id         text NOT NULL UNIQUE REFERENCES chain_events (event_id),
  rule             text NOT NULL CHECK (rule IN ('high_value')),
  contract_address text NOT NULL,
  amount           numeric NOT NULL,
  threshold_units  numeric NOT NULL,
  status           text NOT NULL CHECK (status IN ('open', 'withdrawn')),
  status_reason    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_by_status ON alerts (chain_id, status);

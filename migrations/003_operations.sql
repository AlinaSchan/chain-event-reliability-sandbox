-- Operational evidence: what recovery did, what needs a human, and what the scenario runs observed.

CREATE TABLE recovery_log (
  id         bigserial PRIMARY KEY,
  chain_id   bigint NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('backfill', 'reorg', 'resume', 'halt', 'unhalt', 'replay', 'outbox_requeue')),
  from_block bigint,
  to_block   bigint,
  summary    text NOT NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_log_by_chain ON recovery_log (chain_id, id DESC);

-- Conditions automatic recovery cannot (or should not) settle on its own.
CREATE TABLE incidents (
  id                     bigserial PRIMARY KEY,
  chain_id               bigint NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('scanner_halted', 'confirmed_event_orphaned', 'undecodable_log', 'payload_mismatch')),
  severity               text NOT NULL CHECK (severity IN ('warning', 'critical')),
  requires_manual_review boolean NOT NULL,
  summary                text NOT NULL,
  details                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz,
  resolution_note        text
);
CREATE INDEX incidents_open ON incidents (chain_id) WHERE status = 'open';

CREATE TABLE scenario_runs (
  id          bigserial PRIMARY KEY,
  scenario_id text NOT NULL,
  status      text NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  checks      jsonb NOT NULL,
  evidence    jsonb NOT NULL,
  error       text,
  skip_reason text
);
CREATE INDEX scenario_runs_by_scenario ON scenario_runs (scenario_id, id DESC);

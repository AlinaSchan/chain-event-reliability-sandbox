-- Transactional outbox and the local notification sink.
-- Redis Streams only carries messages; whether a notification has been delivered is decided here.

CREATE TABLE outbox (
  id                   bigserial PRIMARY KEY,
  chain_id             bigint NOT NULL,
  -- Idempotency key of the notification (see src/domain/identity.ts). Not the event id.
  notification_id      text NOT NULL UNIQUE,
  event_id             text NOT NULL REFERENCES chain_events (event_id),
  notification_type    text NOT NULL CHECK (notification_type IN ('event_confirmed', 'event_retracted')),
  payload              jsonb NOT NULL,
  -- pending: written, not yet in Redis.  published: XADDed, effect not yet recorded.
  -- processed: effect recorded in the sink.  suppressed: deliberately not delivered (see status_reason).
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'processed', 'suppressed')),
  status_reason        text,
  publish_attempts     integer NOT NULL DEFAULT 0,
  republish_count      integer NOT NULL DEFAULT 0,
  duplicate_deliveries integer NOT NULL DEFAULT 0,
  last_error           text,
  stream_message_id    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz,
  processed_at         timestamptz
);
CREATE INDEX outbox_open ON outbox (status, id) WHERE status IN ('pending', 'published');
CREATE INDEX outbox_by_event ON outbox (event_id);

-- Stand-in for a downstream system. Delivery is "insert once per notification_id"; the primary key is the
-- idempotency guarantee a real webhook receiver would have to provide.
CREATE TABLE notification_sink (
  notification_id          text PRIMARY KEY REFERENCES outbox (notification_id),
  chain_id                 bigint NOT NULL,
  event_id                 text NOT NULL,
  notification_type        text NOT NULL,
  payload                  jsonb NOT NULL,
  event_status_at_delivery text NOT NULL,
  delivered_at             timestamptz NOT NULL DEFAULT now()
);

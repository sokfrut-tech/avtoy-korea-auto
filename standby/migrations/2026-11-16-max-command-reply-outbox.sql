-- MAX operator command reply outbox.
-- Apply with a dedicated schema-migration identity, never the runtime identity.
-- The existing standby_max_webhook_events and standby_operator_audit_events
-- tables must already exist from the reviewed standby schema.

CREATE TABLE IF NOT EXISTS standby_max_command_replies (
  event_digest Utf8 NOT NULL,
  command_kind Utf8 NOT NULL,
  actor_id Utf8 NOT NULL,
  reply_text Utf8 NOT NULL,
  status Utf8 NOT NULL,
  created_at Utf8 NOT NULL,
  next_attempt_at Utf8 NOT NULL,
  lock_until Utf8 NOT NULL,
  lease_token Utf8 NOT NULL,
  attempts Uint32 NOT NULL,
  last_error Utf8 NOT NULL,
  PRIMARY KEY (event_digest)
);

CREATE INDEX IF NOT EXISTS idx_max_reply_due
ON standby_max_command_replies (status, next_attempt_at) GLOBAL SYNC;

CREATE INDEX IF NOT EXISTS idx_max_reply_lease
ON standby_max_command_replies (status, lock_until) GLOBAL SYNC;

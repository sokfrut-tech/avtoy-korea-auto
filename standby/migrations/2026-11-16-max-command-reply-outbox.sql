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
  INDEX idx_max_reply_due GLOBAL SYNC ON (status, next_attempt_at),
  INDEX idx_max_reply_lease GLOBAL SYNC ON (status, lock_until),
  PRIMARY KEY (event_digest)
);

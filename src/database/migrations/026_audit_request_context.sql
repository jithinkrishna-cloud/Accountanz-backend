-- Request context on audit entries, for read-audit of client JournL data.
-- JournL only sees the owner's session, so these rows are the only record of which Accountanz user read which
-- client's books. outcome: success | denied (403/404) | failed (409, JournL errors). Existing rows stay NULL.
-- Tokens, credentials and accounting payloads are never written here.
ALTER TABLE audit_logs
  ADD COLUMN outcome    ENUM('success','denied','failed') NULL AFTER details,
  ADD COLUMN endpoint   VARCHAR(255) NULL AFTER outcome,
  ADD COLUMN request_id VARCHAR(64)  NULL AFTER endpoint,
  ADD COLUMN ip_address VARCHAR(45)  NULL AFTER request_id,
  ADD KEY ix_audit_actor_created (actor_id, created_at);

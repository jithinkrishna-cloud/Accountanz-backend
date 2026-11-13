-- Manual verification of a JournL connection, kept apart from the API health check.
-- "Mark verified" = an admin checked the organisation in JournL by hand and recorded how.
-- It is not proof that JournL authorised API access; that arrives with the JournL partner grant.
ALTER TABLE integration_connections
  ADD COLUMN verified_by       BIGINT UNSIGNED NULL AFTER last_error,
  ADD COLUMN verified_at       DATETIME NULL AFTER verified_by,
  ADD COLUMN verification_note VARCHAR(500) NULL AFTER verified_at,
  ADD COLUMN disconnected_at   DATETIME NULL AFTER verification_note,
  ADD CONSTRAINT fk_integration_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;

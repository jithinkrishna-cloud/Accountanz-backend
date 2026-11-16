-- A client asks Accountanz for a specific accountant (from the portal's Explore section). An admin approves or
-- declines; approving doesn't assign anyone by itself (an assignment needs dates and a team role), the admin then
-- creates the assignment.
CREATE TABLE accountant_requests (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id       BIGINT UNSIGNED NOT NULL,
  accountant_id   BIGINT UNSIGNED NOT NULL,
  requested_by    BIGINT UNSIGNED NULL,
  kind            ENUM('join_team','one_off') NOT NULL DEFAULT 'join_team' COMMENT 'join the accounting team, or a single piece of work',
  message         VARCHAR(2000) NOT NULL COMMENT 'what the client wants done',
  preferred_start DATE NULL,
  status          ENUM('pending','approved','declined','withdrawn') NOT NULL DEFAULT 'pending',
  decided_by      BIGINT UNSIGNED NULL,
  decided_at      DATETIME NULL,
  decision_note   VARCHAR(1000) NULL COMMENT 'shown to the client',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ar_client (client_id, status),
  KEY ix_ar_status (status, created_at),
  CONSTRAINT fk_ar_client     FOREIGN KEY (client_id)     REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_ar_accountant FOREIGN KEY (accountant_id) REFERENCES users(id)   ON DELETE CASCADE,
  CONSTRAINT fk_ar_requester  FOREIGN KEY (requested_by)  REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT fk_ar_decider    FOREIGN KEY (decided_by)    REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB;

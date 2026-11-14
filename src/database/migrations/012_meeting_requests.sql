-- Clients ask for a meeting; the accounting team schedules it (creating a normal meeting) or declines it.
-- preferred_times holds 1-3 proposed start times as UTC ISO strings; the team may still pick another time.

CREATE TABLE meeting_requests (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id        BIGINT UNSIGNED NOT NULL,
  requested_by     BIGINT UNSIGNED NULL,
  topic            VARCHAR(200)  NOT NULL,
  notes            VARCHAR(2000) NULL,
  preferred_times  JSON          NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  status           ENUM('pending','scheduled','declined','withdrawn') NOT NULL DEFAULT 'pending',
  meeting_id       BIGINT UNSIGNED NULL COMMENT 'the meeting created from this request',
  decided_by       BIGINT UNSIGNED NULL,
  decided_at       DATETIME      NULL,
  decline_reason   VARCHAR(500)  NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_mr_client (client_id, status),
  KEY ix_mr_status (status, created_at),
  CONSTRAINT fk_mr_client       FOREIGN KEY (client_id)    REFERENCES clients(id)  ON DELETE CASCADE,
  CONSTRAINT fk_mr_requested_by FOREIGN KEY (requested_by) REFERENCES users(id)    ON DELETE SET NULL,
  CONSTRAINT fk_mr_meeting      FOREIGN KEY (meeting_id)   REFERENCES meetings(id) ON DELETE SET NULL,
  CONSTRAINT fk_mr_decided_by   FOREIGN KEY (decided_by)   REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB;

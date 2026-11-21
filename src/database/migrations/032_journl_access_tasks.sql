-- JournL logins are given and taken away by hand in JournL (it has no API for accountant access). Each change in
-- Accountanz that needs a JournL change queues one of these to-dos; the access only counts as granted or removed
-- once someone completes it with a note saying how it was confirmed.
--   grant         = add the accountant to the client's JournL company (JournL access turned on / new assignment)
--   revoke        = remove them (JournL access turned off)
--   verify_revoke = the assignment ended: check they no longer have access, remove it if they do
--   update        = hand-over: remove previous_user_id, add user_id
CREATE TABLE journl_access_tasks (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id        BIGINT UNSIGNED NOT NULL,
  assignment_id    BIGINT UNSIGNED NULL,
  user_id          BIGINT UNSIGNED NOT NULL COMMENT 'the accountant whose JournL access changes',
  previous_user_id BIGINT UNSIGNED NULL COMMENT 'update only: the accountant being replaced',
  action           ENUM('grant','revoke','verify_revoke','update') NOT NULL,
  status           ENUM('pending','in_progress','completed','cancelled') NOT NULL DEFAULT 'pending',
  responsible_id   BIGINT UNSIGNED NULL,
  notes            VARCHAR(2000) NULL COMMENT 'how it was confirmed (required to complete), or why it was cancelled',
  completed_at     DATETIME NULL,
  completed_by     BIGINT UNSIGNED NULL,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_jat_status (status, created_at),
  KEY ix_jat_client (client_id, status),
  KEY ix_jat_assignment (assignment_id, status),
  CONSTRAINT fk_jat_client     FOREIGN KEY (client_id)        REFERENCES clients(id)     ON DELETE CASCADE,
  CONSTRAINT fk_jat_assignment FOREIGN KEY (assignment_id)    REFERENCES assignments(id) ON DELETE SET NULL,
  CONSTRAINT fk_jat_user       FOREIGN KEY (user_id)          REFERENCES users(id)       ON DELETE CASCADE,
  CONSTRAINT fk_jat_previous   FOREIGN KEY (previous_user_id) REFERENCES users(id)       ON DELETE SET NULL,
  CONSTRAINT fk_jat_resp       FOREIGN KEY (responsible_id)   REFERENCES users(id)       ON DELETE SET NULL,
  CONSTRAINT fk_jat_completer  FOREIGN KEY (completed_by)     REFERENCES users(id)       ON DELETE SET NULL,
  CONSTRAINT fk_jat_creator    FOREIGN KEY (created_by)       REFERENCES users(id)       ON DELETE SET NULL
) ENGINE=InnoDB;

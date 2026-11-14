-- Workspace time tracking: an original estimate per work item and logged work against it.
-- Durations are stored in minutes; the app shows them as 1w 2d 4h 30m (1d = 8h, 1w = 5d).

ALTER TABLE project_items
  ADD COLUMN original_estimate_minutes INT UNSIGNED NULL AFTER story_points;

CREATE TABLE project_item_worklogs (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NULL,
  minutes    INT UNSIGNED NOT NULL,
  work_date  DATE NOT NULL,
  note       VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_project_worklog_item (item_id, work_date),
  CONSTRAINT fk_project_worklog_item FOREIGN KEY (item_id) REFERENCES project_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_worklog_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT ck_project_worklog_minutes CHECK (minutes > 0)
) ENGINE=InnoDB;

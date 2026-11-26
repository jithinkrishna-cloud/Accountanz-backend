-- Watchers on Workspace work items: space members who follow an item.
CREATE TABLE project_item_watchers (
  item_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id, user_id),
  KEY ix_project_watcher_user (user_id),
  CONSTRAINT fk_project_watcher_item FOREIGN KEY (item_id) REFERENCES project_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_watcher_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_watcher_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

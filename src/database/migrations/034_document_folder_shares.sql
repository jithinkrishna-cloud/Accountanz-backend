-- Client folders are private to the client until shared. Sharing a folder with an accountant on the client's team
-- lets them see it and everything under it (subfolders included). Admins always see every document; top-level
-- documents and documents sent for a team request stay visible to the client's team as before.
CREATE TABLE document_folder_shares (
  folder_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  shared_by  BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (folder_id, user_id),
  KEY ix_share_user (user_id),
  CONSTRAINT fk_share_folder FOREIGN KEY (folder_id) REFERENCES document_folders(id) ON DELETE CASCADE,
  CONSTRAINT fk_share_user   FOREIGN KEY (user_id)   REFERENCES users(id)            ON DELETE CASCADE,
  CONSTRAINT fk_share_by     FOREIGN KEY (shared_by) REFERENCES users(id)            ON DELETE SET NULL
) ENGINE=InnoDB;

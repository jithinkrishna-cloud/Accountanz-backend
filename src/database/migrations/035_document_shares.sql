-- A single client file can be shared with accountants on the client's team, like a folder (see 034). A file the
-- client uploads is private to the client until it is shared directly, sits in a shared folder, or is sent for a
-- team request. Files the team uploads stay visible to the team; admins see everything.
CREATE TABLE document_shares (
  document_id BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  shared_by   BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, user_id),
  KEY ix_docshare_user (user_id),
  CONSTRAINT fk_docshare_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_docshare_user     FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE,
  CONSTRAINT fk_docshare_by       FOREIGN KEY (shared_by)   REFERENCES users(id)     ON DELETE SET NULL
) ENGINE=InnoDB;

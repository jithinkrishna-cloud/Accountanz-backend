-- Client-made folders for the Document Centre. Any depth: a folder's parent is another folder of the same client
-- (NULL = top level). Folder names are unique among siblings (checked in the service: MySQL treats NULL parents
-- as distinct, so a unique key can't cover top-level folders). Only empty folders can be deleted (also checked in
-- the service). The parent key cascades only so that deleting a whole client can remove its folder tree.
CREATE TABLE document_folders (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id  BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED NULL,
  name       VARCHAR(100) NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_folder_client (client_id, parent_id),
  CONSTRAINT fk_folder_client  FOREIGN KEY (client_id)  REFERENCES clients(id)          ON DELETE CASCADE,
  CONSTRAINT fk_folder_parent  FOREIGN KEY (parent_id)  REFERENCES document_folders(id) ON DELETE CASCADE,
  CONSTRAINT fk_folder_creator FOREIGN KEY (created_by) REFERENCES users(id)            ON DELETE SET NULL
) ENGINE=InnoDB;

-- NULL = the Document Centre's top level (every existing document stays there).
ALTER TABLE documents
  ADD COLUMN folder_id BIGINT UNSIGNED NULL AFTER request_id,
  ADD KEY ix_doc_folder (folder_id),
  ADD CONSTRAINT fk_doc_folder FOREIGN KEY (folder_id) REFERENCES document_folders(id) ON DELETE SET NULL;

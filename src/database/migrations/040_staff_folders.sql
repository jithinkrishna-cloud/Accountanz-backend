-- Staff folders: folders the accounting team creates in a client's Document Centre (including the folders made for
-- document requests). They form a shared tree: the client and the client's accounting team both see a staff folder,
-- everything under it and the files in it. Folders the client creates stay private to the client until shared (034).
ALTER TABLE document_folders
  ADD COLUMN staff_folder TINYINT(1) NOT NULL DEFAULT 0 AFTER name;

-- Existing folders made by someone who isn't a client user are staff folders.
UPDATE document_folders f JOIN users u ON u.id = f.created_by
   SET f.staff_folder = 1
 WHERE u.portal_role NOT IN ('client_owner', 'client_member');

-- Each document request gets its own folder ("Nov 2026 / Bank statements"); files sent for it land there.
ALTER TABLE document_requests
  ADD COLUMN folder_id BIGINT UNSIGNED NULL,
  ADD KEY ix_request_folder (folder_id),
  ADD CONSTRAINT fk_request_folder FOREIGN KEY (folder_id) REFERENCES document_folders(id) ON DELETE SET NULL;

-- Who uploaded the signed agreement and when, shown on the engagement (the audit log keeps the full history).
ALTER TABLE engagements
  ADD COLUMN agreement_uploaded_by BIGINT UNSIGNED NULL AFTER agreement_file_name,
  ADD COLUMN agreement_uploaded_at DATETIME NULL AFTER agreement_uploaded_by,
  ADD CONSTRAINT fk_eng_agreement_uploader FOREIGN KEY (agreement_uploaded_by) REFERENCES users(id) ON DELETE SET NULL;

-- Backfill existing agreements from the audit log: the latest "Agreement uploaded" entry per engagement.
UPDATE engagements e
  JOIN (
    SELECT a.entity_id, a.actor_id, a.created_at
      FROM audit_logs a
      JOIN (SELECT entity_id, MAX(id) AS id FROM audit_logs WHERE entity_type = 'Engagement' AND action = 'Agreement uploaded' GROUP BY entity_id) last
        ON last.id = a.id
  ) up ON CAST(up.entity_id AS UNSIGNED) = e.id
   SET e.agreement_uploaded_by = up.actor_id,
       e.agreement_uploaded_at = up.created_at
 WHERE e.agreement_file_path IS NOT NULL;

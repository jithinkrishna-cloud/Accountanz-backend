-- One-off (manual) tasks alongside template-generated ones.
-- creation_source is recorded once at creation: template_item_id cannot carry this fact because
-- deleting a template item clears it (ON DELETE SET NULL).
ALTER TABLE tasks
  ADD COLUMN description TEXT NULL AFTER title,
  ADD COLUMN creation_source ENUM('template','manual') NOT NULL DEFAULT 'template' AFTER template_item_id;

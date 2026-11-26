-- Client workspaces: space kinds, package limits, entitlement overrides, team-sync issues.

-- A STORED generated column cannot depend on a column whose FK is SET NULL/CASCADE.
ALTER TABLE project_spaces DROP FOREIGN KEY fk_project_space_client;
ALTER TABLE project_spaces
  ADD CONSTRAINT fk_project_space_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;

ALTER TABLE project_spaces
  ADD COLUMN kind ENUM('client_primary','client_project','internal') NOT NULL DEFAULT 'internal' AFTER client_id,
  ADD COLUMN archived_at DATETIME NULL AFTER kind;

ALTER TABLE project_space_members
  ADD COLUMN source ENUM('manual','client_team') NOT NULL DEFAULT 'manual' AFTER role;

CREATE TABLE project_space_sync_issues (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  space_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  reason     ENUM('staff_limit','role_not_included','no_active_package') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  UNIQUE KEY uq_project_sync_issue (space_id, user_id),
  CONSTRAINT fk_project_sync_issue_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_sync_issue_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE client_entitlement_overrides (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id  BIGINT UNSIGNED NOT NULL,
  limit_type ENUM('workspaces','staff_per_workspace') NOT NULL,
  extra      INT UNSIGNED NOT NULL,
  reason     VARCHAR(500) NOT NULL,
  expires_at DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  revoked_by BIGINT UNSIGNED NULL,
  KEY ix_entitlement_override_client (client_id, limit_type),
  CONSTRAINT fk_entitlement_override_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT,
  CONSTRAINT fk_entitlement_override_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_entitlement_override_revoker FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Classify existing spaces: oldest linked space per client is primary, other linked are projects.
UPDATE project_spaces SET kind = 'client_project' WHERE client_id IS NOT NULL;
UPDATE project_spaces s
  JOIN (
    SELECT p.client_id, MIN(p.id) AS id
    FROM project_spaces p
    JOIN (SELECT client_id, MIN(created_at) AS created_at FROM project_spaces WHERE client_id IS NOT NULL GROUP BY client_id) m
      ON m.client_id = p.client_id AND m.created_at = p.created_at
    GROUP BY p.client_id
  ) o ON o.id = s.id
  SET s.kind = 'client_primary';

ALTER TABLE project_spaces
  ADD COLUMN primary_client_id BIGINT UNSIGNED AS (IF(kind = 'client_primary', client_id, NULL)) STORED AFTER archived_at,
  ADD UNIQUE KEY uq_project_space_primary (primary_client_id);

ALTER TABLE packages
  ADD COLUMN workspace_limit INT UNSIGNED NULL DEFAULT 1,
  ADD COLUMN staff_per_workspace INT UNSIGNED NULL DEFAULT NULL;

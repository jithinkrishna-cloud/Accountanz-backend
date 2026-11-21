-- Reusable staff groups ("Team A = Meera as finance manager + Arun as bookkeeper"). Assigning a group to a client
-- creates one ordinary assignment per member; assignments stay the source of access. Editing a group later never
-- changes assignments already made from it.
CREATE TABLE staff_groups (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY ux_sg_name (name),
  CONSTRAINT fk_sg_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE staff_group_members (
  group_id      BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  team_role     ENUM('bookkeeper','finance_manager','cfo','reviewer') NOT NULL,
  journl_access BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (group_id, user_id, team_role),
  KEY ix_sgm_user (user_id),
  CONSTRAINT fk_sgm_group FOREIGN KEY (group_id) REFERENCES staff_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_sgm_user  FOREIGN KEY (user_id)  REFERENCES users(id)        ON DELETE CASCADE
) ENGINE=InnoDB;

-- Which group an assignment came from (informational; deleting the group keeps the assignment).
ALTER TABLE assignments
  ADD COLUMN source_group_id BIGINT UNSIGNED NULL AFTER replaced_by_assignment_id,
  ADD KEY ix_asg_group (source_group_id, status),
  ADD CONSTRAINT fk_asg_group FOREIGN KEY (source_group_id) REFERENCES staff_groups(id) ON DELETE SET NULL;

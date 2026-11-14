-- Workspace: internal project tracking for Accountanz staff (spaces, statuses, sprints, work items).
-- Separate from the accounting `tasks` module; a space or item may optionally link to a client.

CREATE TABLE project_spaces (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  space_key        VARCHAR(10) NOT NULL,
  name             VARCHAR(80) NOT NULL,
  description      VARCHAR(1000) NULL,
  template         ENUM('scrum','kanban') NOT NULL,
  client_id        BIGINT UNSIGNED NULL,
  next_item_number INT UNSIGNED NOT NULL DEFAULT 1,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_space_key (space_key),
  CONSTRAINT fk_project_space_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
  CONSTRAINT fk_project_space_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE project_space_members (
  space_id BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  role     ENUM('admin','member') NOT NULL DEFAULT 'member',
  added_by BIGINT UNSIGNED NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (space_id, user_id),
  KEY ix_project_member_user (user_id),
  CONSTRAINT fk_project_member_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_member_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_member_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE project_statuses (
  id       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  space_id BIGINT UNSIGNED NOT NULL,
  name     VARCHAR(40) NOT NULL,
  category ENUM('todo','in_progress','done') NOT NULL,
  position INT NOT NULL,
  UNIQUE KEY uq_project_status_name (space_id, name),
  CONSTRAINT fk_project_status_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE project_sprints (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  space_id     BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(80) NOT NULL,
  goal         VARCHAR(500) NULL,
  start_date   DATE NULL,
  end_date     DATE NULL,
  status       ENUM('planned','active','completed') NOT NULL DEFAULT 'planned',
  completed_at DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_project_sprint_space (space_id, status),
  CONSTRAINT fk_project_sprint_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE project_items (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  space_id     BIGINT UNSIGNED NOT NULL,
  number       INT UNSIGNED NOT NULL,
  type         ENUM('task','bug','story','subtask') NOT NULL DEFAULT 'task',
  title        VARCHAR(255) NOT NULL,
  description  TEXT NULL,
  status_id    BIGINT UNSIGNED NOT NULL,
  priority     ENUM('highest','high','medium','low','lowest') NOT NULL DEFAULT 'medium',
  assignee_id  BIGINT UNSIGNED NULL,
  reporter_id  BIGINT UNSIGNED NULL,
  parent_id    BIGINT UNSIGNED NULL,
  sprint_id    BIGINT UNSIGNED NULL,
  client_id    BIGINT UNSIGNED NULL,
  story_points DECIMAL(6,1) NULL,
  start_date   DATE NULL,
  due_date     DATE NULL,
  `rank`       DOUBLE NOT NULL DEFAULT 0,
  resolved_at  DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_item_number (space_id, number),
  KEY ix_project_item_status (space_id, status_id, `rank`),
  KEY ix_project_item_sprint (space_id, sprint_id, `rank`),
  KEY ix_project_item_parent (parent_id),
  CONSTRAINT fk_project_item_space FOREIGN KEY (space_id) REFERENCES project_spaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_item_status FOREIGN KEY (status_id) REFERENCES project_statuses(id),
  CONSTRAINT fk_project_item_assignee FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_project_item_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_project_item_parent FOREIGN KEY (parent_id) REFERENCES project_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_item_sprint FOREIGN KEY (sprint_id) REFERENCES project_sprints(id) ON DELETE SET NULL,
  CONSTRAINT fk_project_item_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE project_item_labels (
  item_id BIGINT UNSIGNED NOT NULL,
  label   VARCHAR(40) NOT NULL,
  PRIMARY KEY (item_id, label),
  CONSTRAINT fk_project_label_item FOREIGN KEY (item_id) REFERENCES project_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE project_item_comments (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id    BIGINT UNSIGNED NOT NULL,
  author_id  BIGINT UNSIGNED NULL,
  body       TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at  DATETIME NULL,
  KEY ix_project_comment_item (item_id, created_at),
  CONSTRAINT fk_project_comment_item FOREIGN KEY (item_id) REFERENCES project_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_comment_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE project_item_activity (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id    BIGINT UNSIGNED NOT NULL,
  actor_id   BIGINT UNSIGNED NULL,
  action     VARCHAR(40) NOT NULL,
  field      VARCHAR(40) NULL,
  old_value  VARCHAR(500) NULL,
  new_value  VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_project_activity_item (item_id, created_at),
  CONSTRAINT fk_project_activity_item FOREIGN KEY (item_id) REFERENCES project_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_activity_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE project_item_attachments (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  item_id      BIGINT UNSIGNED NOT NULL,
  file_key     VARCHAR(500) NOT NULL,
  file_name    VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  size_bytes   BIGINT UNSIGNED NOT NULL,
  uploaded_by  BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_project_attachment_item (item_id),
  CONSTRAINT fk_project_attachment_item FOREIGN KEY (item_id) REFERENCES project_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_project_attachment_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

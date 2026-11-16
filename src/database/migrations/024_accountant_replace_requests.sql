-- A client can ask to replace someone on their team with a specific accountant. Approving hands the work over
-- (ends the old assignment, starts the new one in the same role, carries JournL permissions over).
ALTER TABLE accountant_requests
  MODIFY kind ENUM('join_team','one_off','replace') NOT NULL DEFAULT 'join_team' COMMENT 'join the team, a single piece of work, or replace a team member',
  ADD COLUMN replaces_assignment_id BIGINT UNSIGNED NULL COMMENT 'kind=replace: the assignment to hand over' AFTER kind,
  ADD CONSTRAINT fk_ar_replaces FOREIGN KEY (replaces_assignment_id) REFERENCES assignments(id) ON DELETE SET NULL;

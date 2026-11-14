-- Client-facing proposals. "Proposal sent" now shows the proposal in the client portal (and emails the owner);
-- the client can accept it there, or the team marks it accepted after an offline conversation.
-- notes stays internal; proposal_message is what the client reads.

ALTER TABLE onboarding_cases
  ADD COLUMN proposal_message VARCHAR(2000) NULL COMMENT 'shown to the client with the proposal' AFTER notes,
  ADD COLUMN proposal_sent_at DATETIME NULL AFTER suggested_monthly_fee,
  ADD COLUMN accepted_at      DATETIME NULL AFTER proposal_sent_at,
  ADD COLUMN accepted_by      BIGINT UNSIGNED NULL AFTER accepted_at,
  ADD COLUMN accepted_via     ENUM('client','team') NULL COMMENT 'client = accepted in the portal; team = marked accepted by staff' AFTER accepted_by,
  ADD CONSTRAINT fk_onb_accepted_by FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL;

-- Cases already at "proposal sent" count as sent when they last changed.
UPDATE onboarding_cases SET proposal_sent_at = updated_at WHERE stage = 'proposal_sent' AND proposal_sent_at IS NULL;

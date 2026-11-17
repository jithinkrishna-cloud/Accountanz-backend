-- Onboarding and engagements describe the same client and the same package, so they are kept in step:
--   * the onboarding case records whether its package came from the team's assessment or the client's own choice;
--   * once a client has a sent/accepted/active engagement, a different package goes through a package change request
--     (asked for by the client in the portal, or made by staff), never through a second, conflicting proposal.
ALTER TABLE onboarding_cases
  ADD COLUMN package_source ENUM('team','client') NULL COMMENT 'who picked suggested_package_id: staff assessment or the client in the portal' AFTER suggested_monthly_fee;

UPDATE onboarding_cases SET package_source = 'team' WHERE suggested_package_id IS NOT NULL;

CREATE TABLE package_change_requests (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  client_id       BIGINT UNSIGNED NOT NULL,
  engagement_id   BIGINT UNSIGNED NOT NULL,
  from_package_id BIGINT UNSIGNED NOT NULL,
  to_package_id   BIGINT UNSIGNED NOT NULL,
  source          ENUM('client','team') NOT NULL COMMENT 'asked for in the portal, or made by staff',
  message         VARCHAR(1000) NULL COMMENT 'why the client wants the change',
  monthly_fee     DECIMAL(12,2) NULL COMMENT 'agreed fee set on approval; null = the new package list price',
  status          ENUM('pending','approved','declined','withdrawn') NOT NULL DEFAULT 'pending',
  requested_by    BIGINT UNSIGNED NULL,
  decided_by      BIGINT UNSIGNED NULL,
  decided_at      DATETIME NULL,
  decision_note   VARCHAR(1000) NULL COMMENT 'shown to the client',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_pcr_engagement (engagement_id, status),
  KEY ix_pcr_client (client_id, status),
  CONSTRAINT fk_pcr_client     FOREIGN KEY (client_id)       REFERENCES clients(id)     ON DELETE CASCADE,
  CONSTRAINT fk_pcr_engagement FOREIGN KEY (engagement_id)   REFERENCES engagements(id) ON DELETE CASCADE,
  CONSTRAINT fk_pcr_from       FOREIGN KEY (from_package_id) REFERENCES packages(id),
  CONSTRAINT fk_pcr_to         FOREIGN KEY (to_package_id)   REFERENCES packages(id),
  CONSTRAINT fk_pcr_requester  FOREIGN KEY (requested_by)    REFERENCES users(id)       ON DELETE SET NULL,
  CONSTRAINT fk_pcr_decider    FOREIGN KEY (decided_by)      REFERENCES users(id)       ON DELETE SET NULL
) ENGINE=InnoDB;

-- Repair cases that already contradict their client's engagement (e.g. an active engagement on a case still
-- at "registered"). The open engagement wins: its package and fee become the case's package.
UPDATE onboarding_cases oc
  JOIN engagements e ON e.id = (SELECT MAX(e2.id) FROM engagements e2 WHERE e2.client_id = oc.client_id AND e2.status <> 'ended')
  JOIN packages p ON p.id = e.package_id
   SET oc.suggested_package_id  = e.package_id,
       oc.suggested_monthly_fee = COALESCE(e.monthly_fee, p.monthly_fee),
       oc.package_source        = COALESCE(oc.package_source, 'client'),
       oc.stage                 = 'accepted',
       oc.accepted_at           = COALESCE(oc.accepted_at, e.updated_at),
       oc.accepted_via          = COALESCE(oc.accepted_via, 'team')
 WHERE oc.stage IN ('registered','assessment','proposal_sent','rejected')
   AND e.status IN ('accepted','active');

-- A draft/sent engagement on a case nobody has assessed yet: the client chose it in the portal.
UPDATE onboarding_cases oc
  JOIN engagements e ON e.id = (SELECT MAX(e2.id) FROM engagements e2 WHERE e2.client_id = oc.client_id AND e2.status <> 'ended')
  JOIN packages p ON p.id = e.package_id
   SET oc.suggested_package_id  = e.package_id,
       oc.suggested_monthly_fee = COALESCE(e.monthly_fee, p.monthly_fee),
       oc.package_source        = 'client',
       oc.stage                 = 'assessment'
 WHERE oc.stage IN ('registered','assessment')
   AND oc.suggested_package_id IS NULL
   AND e.status IN ('draft','sent');
  
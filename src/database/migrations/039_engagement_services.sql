-- Per-client services: an engagement can carry its own service list. When it has none, the package's services
-- apply (every existing engagement keeps working unchanged). Task generation uses the effective list.
CREATE TABLE engagement_services (
  engagement_id BIGINT UNSIGNED NOT NULL,
  service_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (engagement_id, service_id),
  CONSTRAINT fk_es_engagement FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE,
  CONSTRAINT fk_es_service    FOREIGN KEY (service_id)    REFERENCES services(id)    ON DELETE RESTRICT
) ENGINE=InnoDB;

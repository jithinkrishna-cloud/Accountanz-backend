-- @mentions in messages. The body keeps the readable "@Full Name"; this table records who was mentioned,
-- so they can be notified and find the conversation under "Mentions".

CREATE TABLE message_mentions (
  message_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (message_id, user_id),
  KEY ix_mention_user (user_id),
  CONSTRAINT fk_mention_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_mention_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB;

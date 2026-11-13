-- Staff-side delivery: internal (staff-only) discussions live beside client conversations.
-- Existing threads were all started by or with clients, so they stay client-visible.
ALTER TABLE message_threads
  ADD COLUMN visibility ENUM('client','internal') NOT NULL DEFAULT 'client' AFTER subject,
  ADD KEY ix_thread_client_visibility (client_id, visibility);

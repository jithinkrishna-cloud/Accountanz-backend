-- Authors can correct a message for a short while after sending it; edited_at marks it "edited".
ALTER TABLE messages ADD COLUMN edited_at DATETIME NULL AFTER created_at;

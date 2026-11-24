ALTER TABLE ease_assistant_actions DROP CONSTRAINT ease_assistant_actions_kind_check;
ALTER TABLE ease_assistant_actions ADD CONSTRAINT ease_assistant_actions_kind_check
    CHECK (kind IN ('task', 'event', 'snippet', 'reply', 'flashcard', 'shopping'));

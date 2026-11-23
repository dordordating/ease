CREATE TABLE ease_assistant_actions (
    user_id UUID NOT NULL,
    request_id UUID NOT NULL,
    position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 4),
    kind TEXT NOT NULL CHECK (kind IN ('task', 'event', 'snippet', 'reply', 'flashcard')),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    PRIMARY KEY (user_id, request_id, position),
    FOREIGN KEY (user_id, request_id) REFERENCES ease_assistant_requests (user_id, request_id) ON DELETE CASCADE
);

CREATE VIEW ease_assistant_action_review AS
SELECT action.request_id, action.position, action.kind, action.payload, request.created_at, request.expires_at
FROM ease_assistant_actions AS action
JOIN ease_assistant_requests AS request USING (user_id, request_id)
WHERE request.completed_at IS NOT NULL AND request.expires_at > CURRENT_TIMESTAMP;

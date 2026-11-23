CREATE TABLE ease_assistant_models (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE ease_assistant_guides (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    UNIQUE (name, version)
);

CREATE TABLE ease_assistant_requests (
    user_id UUID NOT NULL REFERENCES ease_users (id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    locale TEXT NOT NULL,
    source_count SMALLINT NOT NULL CHECK (source_count BETWEEN 0 AND 4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '720 hours'),
    completed_at TIMESTAMPTZ,
    model_id INTEGER REFERENCES ease_assistant_models (id),
    guide_id INTEGER REFERENCES ease_assistant_guides (id),
    used_fallback BOOLEAN,
    category TEXT,
    feedback TEXT CHECK (feedback IN ('helpful', 'unhelpful')),
    PRIMARY KEY (user_id, request_id)
);

CREATE INDEX ease_assistant_requests_expiry ON ease_assistant_requests (expires_at);

CREATE TABLE ease_assistant_messages (
    user_id UUID NOT NULL,
    request_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('prompt', 'answer')),
    body TEXT NOT NULL,
    PRIMARY KEY (user_id, request_id, role),
    FOREIGN KEY (user_id, request_id) REFERENCES ease_assistant_requests (user_id, request_id) ON DELETE CASCADE
);

CREATE VIEW ease_assistant_review AS
SELECT request.request_id, request.created_at, request.expires_at, request.locale, request.source_count,
       request.category, request.used_fallback, request.feedback,
       model.name AS model, guide.name AS guide, guide.version AS guide_version,
       prompt.body AS prompt, answer.body AS answer,
       EXTRACT(EPOCH FROM request.completed_at - request.created_at) AS duration_seconds
FROM ease_assistant_requests AS request
JOIN ease_assistant_models AS model ON model.id = request.model_id
JOIN ease_assistant_guides AS guide ON guide.id = request.guide_id
JOIN ease_assistant_messages AS prompt USING (user_id, request_id)
JOIN ease_assistant_messages AS answer USING (user_id, request_id)
WHERE prompt.role = 'prompt' AND answer.role = 'answer' AND request.expires_at > CURRENT_TIMESTAMP;

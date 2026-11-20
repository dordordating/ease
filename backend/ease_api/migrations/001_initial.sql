CREATE TABLE ease_users (
    id UUID PRIMARY KEY,
    google_subject TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ease_translation_global_daily (
    day_utc DATE PRIMARY KEY,
    request_count BIGINT NOT NULL CHECK (request_count > 0)
);

CREATE TABLE ease_translation_user_daily (
    user_id UUID NOT NULL REFERENCES ease_users (id) ON DELETE CASCADE,
    day_utc DATE NOT NULL,
    request_count BIGINT NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (user_id, day_utc)
);

CREATE TABLE ease_translation_tier_daily (
    day_utc DATE NOT NULL,
    tier TEXT NOT NULL CHECK (tier <> ''),
    request_count BIGINT NOT NULL CHECK (request_count > 0),
    PRIMARY KEY (day_utc, tier)
);

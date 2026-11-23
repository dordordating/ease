CREATE TABLE ease_account_workspace_sync (
    user_id UUID PRIMARY KEY REFERENCES ease_users (id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    salt BYTEA NOT NULL CHECK (octet_length(salt) = 16),
    iv BYTEA NOT NULL CHECK (octet_length(iv) = 12),
    ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 16 AND 10485776)
);

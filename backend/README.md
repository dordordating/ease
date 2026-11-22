# Ease API

Ease API uses FastAPI and PostgreSQL. It checks Google credentials, keeps one account per Google identity, and gives signed-in users access to three OpenRouter translation tiers. The Chrome extension calls the deployed API from its service worker when the user chooses an online engine in Translator. Its **Precision** label maps to the `premium` API tier.

## Deploy on Coolify

1. Add a **Docker Compose** resource to the project for your server. Select this repository and the `main` branch. Set the base directory to `/` and the Compose location to `/compose.yaml`.
2. Set the required environment variables on the resource. Use [`../.env.example`](../.env.example) as a reference when setting values.

   | Variable | Value |
   | --- | --- |
   | `POSTGRES_PASSWORD` | A generated database password. `openssl rand -hex 32` generates a suitable value. |
   | `SESSION_SECRET` | A separate generated secret of at least 32 characters. |
   | `OPENROUTER_API_KEY` | An OpenRouter key dedicated to Ease. Set an initial credit limit on the key in OpenRouter. |
   | `GOOGLE_CLIENT_IDS` | The public Chrome extension OAuth client ID from `manifest.json`. For multiple registered builds, use a comma-separated list. |
   | `CORS_ORIGINS` | Optional until the extension is connected. Use `chrome-extension://` followed by the stable ID shown under `chrome://extensions`. For multiple builds, list each full origin separated by a comma. |

3. Point an API subdomain to the Coolify server. In the resource, assign that HTTPS domain to the `api` service on container port `8000`, for example `https://api.example.com:8000` in Coolify's domain field. Keep `db` on the private Compose network.
4. Deploy the resource. Request `https://api.example.com/healthz` and check for `{"status":"ok"}`. The API applies PostgreSQL migrations on startup. The named `postgres-data` volume holds the data across redeploys. Keep that volume when updating, and back up the database before restoring or moving it.

The initial limits are **0.5 vCPU and 512 MiB per container** for both the API and PostgreSQL. The API starts with one worker. The Docker Compose file sets the resource limits for the installation.

## Configure email connections

Mail connects separately from the Ease account. The extension fetches inbox headers directly from Google's Gmail API or Microsoft Graph. The broker handles OAuth code exchange and token renewal and does not store provider credentials or messages in PostgreSQL. Each provider is enabled independently when its credentials and the shared settings are supplied.

1. Set `MAIL_OAUTH_ORIGIN` to your public HTTPS API origin without a trailing slash and `MAIL_EXTENSION_IDS` to the comma-separated extension IDs shown on `chrome://extensions`. For a production OAuth consent screen, use a domain you control.
2. For Gmail, enable the Gmail API in Google Cloud. Create an OAuth client of type **Web application** and add `<MAIL_OAUTH_ORIGIN>/v1/mail/oauth/gmail/callback` as an authorized redirect URI. Configure `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send` and add test accounts if the consent screen is in testing. Set `MAIL_GOOGLE_CLIENT_ID` and `MAIL_GOOGLE_CLIENT_SECRET` in Coolify. The Chrome-extension OAuth client used for Ease login is separate.
3. For Outlook, register a Microsoft Entra application that supports work/school and personal Microsoft accounts. Add a **Web** redirect URI of `<MAIL_OAUTH_ORIGIN>/v1/mail/oauth/outlook/callback`. Grant delegated Microsoft Graph `Mail.Read`, `Mail.Send` and `User.Read` permissions. The OAuth flow requests `offline_access` to refresh the inbox after the browser restarts. Set `MAIL_MICROSOFT_CLIENT_ID` and `MAIL_MICROSOFT_CLIENT_SECRET` in Coolify, using the secret value.
4. Redeploy and check `/v1/mail/config?extension=<extension-id>`. A configured provider returns `true` for an allowed extension ID. Verify consent and fetching in Chrome. OAuth callback queries contain short-lived authorization codes, so configure any upstream access logging to omit the query for both callback paths. Uvicorn omits these requests from its access log.

To enable marking messages as read, add Gmail’s `https://www.googleapis.com/auth/gmail.modify` or Microsoft Graph’s delegated `Mail.ReadWrite` permission. Ease requests it when the user opts in. Clients with unverified or restricted OAuth consent can be limited to approved test users. For Gmail testing, refresh-token expiration depends on the OAuth consent-screen publishing status.

### IMAP connections

The iCloud and Yahoo presets use their public IMAP hosts with provider-issued application passwords. Other providers can use an IMAP hostname and password on implicit TLS (993) or STARTTLS (143). The server only connects to publicly routable addresses pinned to the lookup result and checks the certificate against the requested hostname. Providers that require an OAuth-only, POP-only, or private-network connection require a different connector.

Allow outbound TCP 993 and 143 from the Ease API container. The API reads the inbox in read-only mode and returns recent From and Subject headers, timestamps, read status, and the unread total. It keeps request credentials and the snapshot in memory for the request, with no database storage. The extension stores IMAP credentials and snapshots on the device. Keep reverse-proxy request-body logging disabled for `/v1/mail/imap/sync`.

The reader fetches the preferred HTML or plain-text MIME part on demand through `/v1/mail/imap/message`. Inbox opens can set the IMAP `\\Seen` flag by UID. Sent discovery uses the IMAP `\\Sent` role and falls back to common mailbox names. IMAP accounts can submit via `/v1/mail/smtp/send` with SMTP STARTTLS on 587 or implicit TLS on 465. After SMTP accepts a message, Ease checks for a server-side copy by Message-ID before appending a copy to Sent. Allow outbound TCP on the used SMTP port and keep request-body logging disabled on both routes.

## Translation tiers and limits

| Tier | Default OpenRouter model | Override |
| --- | --- | --- |
| `economy` | `google/gemma-4-31b-it` | `OPENROUTER_MODEL_ECONOMY` |
| `standard` | `google/gemini-2.5-flash-lite` | `OPENROUTER_MODEL_STANDARD` |
| `premium` | `openai/gpt-5.6-luna` | `OPENROUTER_MODEL_PREMIUM` |

Change the tier models and limits through the backend environment, then redeploy. The defaults are 30 requests per user per day, 200 total per day, 4,000 input characters, and 3,000 output tokens. A valid request reserves quota before the provider call and counts even if the provider fails. The daily counters reset at midnight UTC.

PostgreSQL stores the user's Google subject, email, display name, account timestamps, and daily aggregate request counts. Translation text and results are sent to or received from OpenRouter in memory. The API keeps both the Google access token and the OpenRouter key out of the account database.

## Markets data

`GET /v1/markets/catalogue?q=BTC%2FTMN` looks up pairs on demand. Use the returned market ID with `GET /v1/markets/quotes?symbols=...` or `GET /v1/markets/history?symbol=...`. Quote requests take up to 50 IDs, and omitting the filter returns the original starter set for earlier extensions. The endpoints are available to guests and share bounded caches.

`GET /v1/markets/icon?symbol=wlx%3AGRAM%2FTMN` returns a small raster icon for supported assets, with a 64 KiB limit. Ease caches the result by provider and base asset on the server and in the browser.

Ease derives FX crosses from daily EUR reference rates. CoinGecko quotes are batched and cached for ten minutes. Crypto-to-crypto crosses without a direct quote divide compatible USD prices. Wallex’s public market snapshot is cached for two minutes. Its timestamp records when Ease retrieved the snapshot, and history uses the venue’s hourly closing prices. If needed for testing, set a server-side `COINGECKO_DEMO_API_KEY`. Confirm the data display license for a public release. [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) · [CoinGecko API terms](https://www.coingecko.com/en/api_terms) · [Wallex markets API](https://api.wallex.ir/v1/markets)

## API contract

| Method and path | Request and result |
| --- | --- |
| `GET /healthz` | Public database readiness result. |
| `POST /v1/auth/google` | Send `{"access_token":"<Google access token>"}` with `Content-Type: application/json`. Ease verifies the token and returns `access_token`, `token_type`, `expires_in`, and `user`. This step registers a new user or refreshes an existing profile. |
| `GET /v1/me` | Send the Ease access token in the `Authorization: Bearer` header to read the current account. |
| `GET /v1/translation-tiers` | Send the Ease access token to get the tier IDs and active models. |
| `POST /v1/translate` | Send the Ease access token and `{"text":"Hello, {name}","source":"en","target":"fa","tier":"standard"}` as JSON. The response contains `text`, `tier`, and `model`. `source` defaults to `auto` and `tier` defaults to `standard`. |

Include `"notes_language":"fa"` to request learning notes in Persian. For an eligible short word or phrase, the response can include `learning.usage`, `learning.example`, `learning.example_translation`, `learning.example_language`, and `learning.source_language`. The example is in the target language by default. If the notes language is the target language, the example is in the source language. The translation and notes use the same provider request.

## Encrypted workspace sync

`GET /v1/workspace-sync` and `PUT /v1/workspace-sync` require the same verified Ease session. The endpoint accepts an encrypted envelope with schema version, salt, IV, and ciphertext. The browser derives the key from the sync passphrase, encrypts the workspace with AES-256-GCM, and handles all restore operations. PostgreSQL stores the ciphertext with an account ID and revision. A `PUT` using a stale revision returns `409`, allowing the browser to handle conflicts before replacing any copy.

Use a Google access token with the `openid`, `email`, and `profile` scopes to start a session. The Ease token expires after 30 minutes by default. For `429` responses, the `Retry-After` header gives the seconds until the quota resets.

## Run locally

From the repository root, copy `.env.example` to `.env` and fill in the values. Run `docker compose up --build -d`, then check readiness inside the API container.

```sh
docker compose exec api python -c 'from urllib.request import urlopen; print(urlopen("http://127.0.0.1:8000/healthz").read().decode())'
```

Stop the services with `docker compose down` to retain the named data volume.

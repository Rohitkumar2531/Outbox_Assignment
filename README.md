# ReachInbox

A full-stack email scheduling application built with React, Express, Prisma/MySQL, BullMQ/Redis, Ethereal SMTP, Slack and Google OAuth, Elasticsearch, and Socket.IO. The frontend is in `client`; the API and independent worker processes are in `server`.

The provided Figma URL could not be loaded from this environment. The dashboard follows the layout and interaction requirements in the brief; visual spacing and components should be compared against the reference once it is accessible.

## Local setup

1. Install Node.js 20+ and Docker Compose.
2. Run `npm install` at the repository root.
3. Copy `.env.example` to the repository root as `.env` (or to `server/.env`) and set secrets and OAuth credentials. The server loads `server/.env` first and falls back to the root `.env`. Create a 32-byte key using `openssl rand -hex 32`. For local MySQL use the matching development credentials in the connection string.
4. Start infrastructure with `docker compose up -d`.
5. Run `npm --workspace server run prisma:generate` and `npm --workspace server run prisma:migrate`.
6. Create an Ethereal account at https://ethereal.email/create and put its SMTP credentials in `server/.env`. Ethereal accepts test mail and provides preview pages; messages are not delivered to actual inboxes.
7. Start API, worker, and Vite with `npm run dev` (or start separately via `npm run dev:server`, `npm run dev:worker`, `npm run dev:client`).
8. Configure Google OAuth consent and a web client. Add `http://localhost:4000/api/auth/google/callback` as an authorized redirect URI.
9. Create a Slack app, enable OAuth, add `chat:write`, set redirect URI to `http://localhost:4000/api/slack/callback`, then set its client ID and secret. Connect Slack from the dashboard.

## Architecture and delivery

Prisma persists campaigns, emails, sender accounts, Slack integration, and an outbox row in the same database transaction. The independent worker polls undispatched outbox rows and writes delayed BullMQ jobs with stable `email-<id>` job IDs. Redis AOF and BullMQ retain delayed jobs across process restarts; the outbox poll recovers a database commit whose queue dispatch did not complete. Jobs use five attempts with exponential backoff and bounded retention. `WORKER_CONCURRENCY` controls worker concurrency.

SMTP does not support a transaction with MySQL or BullMQ. If a worker loses its connection after the SMTP server accepted a message but before the database records success, a retry can send a duplicate. Idempotency keys prevent duplicate schedule API writes and stable queue IDs reduce duplicate job creation, but the system does not promise exactly-once SMTP delivery. SMTP delivery is best effort with at-least-once retry behavior for ambiguous failures.

The worker checks database status before sending. A Redis Lua reservation enforces a shared per-sender hourly quota; sender limits are capped by `MAX_EMAILS_PER_HOUR`. `EMAIL_MIN_DELAY_SECONDS` and each sender's delay govern pacing. When a quota is exhausted, jobs are delayed to the next UTC hour and a Slack alert is sent. A sender/hour alert deduplication key is used by Redis. Outbox polling dispatches up to 100 at a time. With 1,000+ due messages, jobs remain persisted and are consumed at configured concurrency; quota scheduling spreads work over subsequent hours instead of dropping jobs. Ordering is approximate across workers, with queue insertion ordered by scheduled time.

## API

All APIs are under `/api`; protected routes use the HttpOnly `reachinbox` cookie.

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/google`, `/auth/google/callback`, `/auth/me` | Google login and current user |
| POST | `/auth/logout` | Clear login cookie |
| POST | `/emails/schedule` | Create campaign, email rows, and outbox jobs |
| GET | `/emails/scheduled`, `/emails/sent`, `/emails/:id` | Paginated email lists and detail |
| POST | `/emails/:id/cancel` | Cancel an unsent scheduled email |
| GET | `/campaigns`, `/campaigns/:id` | Campaign data |
| GET/POST | `/senders` | List or create sender accounts |
| PATCH | `/senders/:id` | Update sender pacing/quota |
| GET/DELETE | `/slack/connect`, `/slack/disconnect` | Slack OAuth and disconnect |
| GET | `/search/emails?q=&status=&page=&limit=` | User-scoped search; Elasticsearch with DB fallback |
| GET | `/dashboard/stats`, `/queue` | Dashboard and queue counts |
| GET | `/health` | Liveness check |

Scheduling body: `{ "senderId": "...", "subject": "...", "body": "...", "recipients": ["a@example.com"], "startAt": "2026-11-24T10:00:00.000Z", "delaySeconds": 2, "idempotencyKey": "client-generated-request-key" }`. Recipient data is validated and deduplicated. Database unique keys guard duplicate recipient rows for a request. Sender quota settings are validated and capped server-side.

## Integrations and operations

- **Google:** Passport OAuth creates or updates the MySQL user; authentication uses a signed, HttpOnly cookie. Google credentials are optional at startup to permit infrastructure-only development; login returns a configuration error until set.
- **Slack:** OAuth state is signed and checked against an HttpOnly state cookie. Bot tokens are encrypted with AES-256-GCM using `ENCRYPTION_KEY`; the app requests `chat:write`, `im:write`, and `users:read.email` to send a private DM to the user who connected it. Alerts use Slack `chat.postMessage` and failures do not fail email sends. SMTP sender passwords are also encrypted before storage.
- **Ethereal:** Configure global SMTP settings or sender-specific SMTP JSON. Verify and send errors use BullMQ retries. Preview URL and provider message ID are persisted on the email row and returned as the worker job result.
- **Elasticsearch:** Scheduled emails are indexed and send/fail updates re-indexed. Search filters by authenticated user. When unavailable, indexing errors are logged and search falls back to Prisma; production deployments should add an indexing reconciliation process and monitor index lag.
- **Bull Board:** Queue counts are available on authenticated `/api/queue`; the Bull Board UI is at `/api/admin/queues` and requires the signed-in email to be listed in `QUEUE_DASHBOARD_EMAILS`.
- **Socket.IO:** Socket connections require the signed user cookie and updates are emitted to that user's room.

## Database

`server/prisma/schema.prisma` contains User, Sender, EmailCampaign, Email, Outbox, and SlackIntegration models with user ownership foreign keys, unique Google/email/idempotency constraints, and query indexes. Prisma migrations are created by `prisma migrate dev`.

## Checks

`npm run typecheck`, `npm run build`, and `npm test --workspace server` run TypeScript/build checks and unit tests. For the live Ethereal test, keep MySQL, Redis, API, and the separate worker running, then run `$env:RUN_EMAIL_INTEGRATION='true'; npm test --workspace server` in PowerShell (or `RUN_EMAIL_INTEGRATION=true npm test --workspace server` in a POSIX shell). The integration test schedules through the API 30 seconds ahead, checks the initial delayed BullMQ state, and verifies SMTP acceptance, DB status, preview URL, and completed job. A future delayed job must exist to run its worker-restart assertion. The integration test uses Ethereal, which is a preview/testing service and does not deliver to real inboxes.

## Troubleshooting

- `Environment validation failed`: configure `DATABASE_URL`, `JWT_SECRET`, and `SESSION_SECRET` in `server/.env`.
- Database unavailable: check Docker health with `docker compose ps`, then rerun Prisma migration.
- Emails stay scheduled: confirm worker is running and Redis is healthy; inspect worker logs and outbox dispatch errors.
- Email sender authentication: sender-specific SMTP credentials override the global Ethereal account. A `535 Authentication failed` response means the configured sender credentials need updating. Credentials are encrypted in MySQL; SMTP passwords are never logged. Ethereal previews are test messages only.
- Worker process: start `npm run dev:worker` (from the repository root, `npm run dev` starts API, worker, and client together). Starting only the API does not consume delayed jobs.
- Slack state or redirect errors: match the configured redirect URI in Slack and in `.env` exactly.
- Search delays: check Elasticsearch health; DB fallback remains available while the index is down.

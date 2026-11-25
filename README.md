# ReachInbox

ReachInbox is a full-stack email scheduling application. The React/Vite frontend talks to an Express API. MySQL stores users, senders, campaigns, emails, and dispatch records; Redis powers BullMQ's durable delayed queue and Socket.IO updates. A separate worker consumes email jobs and sends them through SMTP.

## Requirements

- Node.js 20 or newer and npm
- Docker with Docker Compose (for local MySQL, Redis, and optional Elasticsearch)
- Google OAuth credentials to use Google login
- Ethereal SMTP credentials for safe email testing

## Configure environment

Copy `.env.example` to `.env` in the repository root. The server loads `server/.env` first if present, then falls back to the root `.env`. Set at least:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | MySQL connection URL, for example `mysql://reachinbox:reachinbox_dev@localhost:3306/reachinbox` when using the included Compose setup |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis connection settings; local defaults are `localhost`, `6379`, and no password |
| `JWT_SECRET`, `SESSION_SECRET` | Independent random secrets, each at least 16 characters |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth credentials; required for login |
| `GOOGLE_CALLBACK_URL` | OAuth callback, locally `http://localhost:4000/api/auth/google/callback` |
| `ETHEREAL_HOST`, `ETHEREAL_PORT`, `ETHEREAL_USER`, `ETHEREAL_PASS` | Default SMTP connection; host and port default to Ethereal's `smtp.ethereal.email:587` |
| `CLIENT_URL`, `SERVER_URL` | Frontend and API origins; local defaults are `http://localhost:5173` and `http://localhost:4000` |
| `VITE_API_URL`, `VITE_SERVER_URL` | Optional frontend API and Socket.IO origins; default to local API URLs. Set these at frontend build time when deploying |
| `ENCRYPTION_KEY` | 32-byte hex key for encrypting stored sender SMTP passwords and Slack tokens |

Generate strong secrets rather than using example values. For example, `openssl rand -hex 32` generates a 32-byte hex secret. Keep `.env` out of source control and never use development credentials in a public deployment.

Optional integrations/settings include `ELASTICSEARCH_NODE` (email search; database fallback is used if unset/unavailable), `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`, `QUEUE_DASHBOARD_EMAILS`, `WORKER_CONCURRENCY`, `EMAIL_MIN_DELAY_SECONDS`, `MAX_EMAILS_PER_HOUR`, and `PORT`. Slack OAuth requires the callback URL to match the Slack app configuration exactly.

## Run locally

From the repository root:

```sh
npm install
docker compose up -d
npm --workspace server run prisma:generate
npm --workspace server exec prisma migrate deploy
npm run dev
```

The Compose file starts MySQL, Redis, and Elasticsearch. Elasticsearch is optional for the app. The first local database setup may use `prisma migrate dev` to create/apply a development migration; `prisma migrate deploy` applies checked-in migrations and is appropriate for a clean setup or deployment. Ensure `DATABASE_URL` matches the MySQL user, password, and database configured in `docker-compose.yml`.

`npm run dev` starts the API, background worker, and frontend together:

- Frontend: `http://localhost:5173`
- API and health endpoint: `http://localhost:4000` and `http://localhost:4000/health`

You can also run them separately in three terminals:

```sh
npm run dev:server
npm run dev:worker
npm run dev:client
```

The production build scripts are `npm run build`, `npm --workspace server run start` (API), and `npm --workspace server run worker` (worker). The frontend build output is `client/dist`.

## Ethereal Email setup

1. Create a test mailbox at [ethereal.email/create](https://ethereal.email/create).
2. Put the generated SMTP username and password in `ETHEREAL_USER` and `ETHEREAL_PASS`. Keep `ETHEREAL_HOST=smtp.ethereal.email` and `ETHEREAL_PORT=587` unless Ethereal gives different connection details.
3. Restart the API/worker after changing environment variables.
4. In the app, add a sender with an email address and SMTP settings. Leave its username/password blank to use the server-level Ethereal credentials, or enter sender-specific SMTP credentials. Stored sender passwords are encrypted using `ENCRYPTION_KEY`.
5. Schedule a message and open its Ethereal preview link from the sent message details.

Ethereal accepts messages for preview and **does not deliver to real inboxes**. Use a real SMTP delivery provider for production email. The worker verifies SMTP credentials when it attempts to send.

## Architecture

### Scheduling and dispatch

The frontend posts a sender, subject, body, recipient list, scheduled start time, and idempotency key to `POST /api/emails/schedule`. The API validates and deduplicates recipients, applies the sender's pacing and hourly cap, then creates the campaign, email rows, and outbox rows in one MySQL transaction. A schedule plan spaces messages by the configured minimum delay and rolls excess recipients into later hours. The API/worker dispatches each outbox item into BullMQ as a delayed job with a stable `email-<id>` job ID.

### Persistence and restart recovery

MySQL is the system of record for scheduled emails and the transactional outbox. Redis runs with append-only persistence in the included Compose setup; BullMQ stores delayed jobs there. The worker periodically scans undispatched outbox rows and can recreate a missing queue job from the database. It also checks for emails left in `processing` without a corresponding queue job and requeues them. BullMQ retries failed sends up to five times with exponential backoff. This supports recovery across process restarts, but SMTP and MySQL cannot participate in one transaction, so a connection loss after SMTP accepts a message can result in a duplicate retry.

### Rate limiting and concurrency

Each sender has a minimum delay and hourly limit. The schedule planner spreads bulk recipients across time; the worker also uses Redis Lua reservations to enforce shared per-sender pacing and hourly quotas across worker processes. When the hourly quota is reached, a job is delayed until the next UTC hour. `MAX_EMAILS_PER_HOUR` caps the configured sender limit. `WORKER_CONCURRENCY` sets the number of jobs one worker can process at once; BullMQ/Redis coordinate queue work among multiple worker instances. Delivery is best effort with at-least-once retry behavior, not exactly-once SMTP delivery.

## Implemented features

### Backend

- Google OAuth login, signed HttpOnly authentication cookie, logout, and authenticated API routes.
- Email scheduling with input validation, recipient deduplication, idempotency keys, campaigns, and cancellation of unsent jobs.
- Prisma/MySQL persistence for users, senders, campaigns, email status, Slack integration, and transactional outbox records.
- BullMQ delayed email queue, stable job IDs, retry/backoff, outbox dispatch, and restart recovery.
- Per-sender minimum delay and hourly quotas enforced across workers through Redis; configurable worker concurrency.
- SMTP sending through Ethereal or sender-specific SMTP settings; encrypted credentials, send status, provider ID, and Ethereal preview URL tracking.
- Paginated scheduled/sent email APIs, campaign and sender management, dashboard and queue stats, and email detail endpoints.
- Elasticsearch email indexing/search with a MySQL-backed search fallback when Elasticsearch is unavailable.
- Optional Slack integration for hourly quota notifications; Socket.IO updates for email status changes.
- Health endpoint and optional Bull Board queue dashboard restricted by `QUEUE_DASHBOARD_EMAILS`.

### Frontend

- Google login screen and authenticated application shell with account identity and logout.
- Overview dashboard with scheduled, sent, failed, and queue activity counts.
- Compose form for scheduling email to multiple recipients, choosing a sender, and setting message content and timing.
- Scheduled and sent email tables with pagination, recipient/subject search, status filtering, refresh, and status indicators.
- Email detail view with message content, delivery/error information, and Ethereal preview link when available.
- Sender management for SMTP configuration, per-sender hourly limit, and minimum delay.
- Integrations panel for Slack connection and SMTP sender management.
- Responsive navigation, loading/empty/error states, and live/poll-refreshed email status updates.

## Useful commands

```sh
npm run typecheck
npm run build
npm test --workspace server
```

The live email integration test requires MySQL, Redis, the API, the worker, and Ethereal credentials; see the test instructions in the server workspace before running it.

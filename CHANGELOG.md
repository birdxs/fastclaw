# Changelog

Notable changes to FastClaw. Items marked **BREAKING** require operator
action on upgrade — read those notes before deploying.

## [Unreleased]

### Changed — `/v1/chat/completions` no longer falls back to another agent

Naming an agent (`agent_id` in the body or `X-Fastclaw-Agent-ID`) that
doesn't exist, or that isn't one of the API key's app's agents, now returns
`404` with `error.code = "agent_not_found"`. Previously FastClaw silently
answered with the default (or an arbitrary) agent. Requests that don't name
an agent still use the default agent. Scripts that passed a stale or wrong
agent ID will now get a 404 instead of a reply from some other agent.

### Added — runtime API for integrating apps

- **Agent management on `/v1`:** `POST/GET/PATCH/DELETE /v1/agents[/{id}]`
  and `PUT /v1/agents/{id}/system-files/{name}`. Agents belong to the app
  (the API key's app). `GET /v1/agents` now returns `display_name`,
  `description`, `metadata` and timestamps, reads from the database, and
  supports `limit`/`cursor` pagination and `metadata[key]=value` filters.
  `name` still equals `id` for compatibility.
- **End-user is a data namespace, not an identity switch:** with
  `X-Fastclaw-End-User` or the chat body field `user`, the agent is resolved
  from the app — so the app's agents are now usable for its end-users (this
  previously returned 404) — while session history, USER.md and personal
  memory stay per end-user under the existing app_user records. No data
  migration.
- **`params.speaker`** (`{"id", "name"}`) tells the agent who is speaking in a
  group conversation; it is per-turn context and never persisted.
- **`project_id`** on `/v1/chat/completions` files the conversation under one
  of the agent's projects.
- **`GET /v1/usage`** accepts `agent_id`, `end_user` and `scope=app`; daily
  rows include `userId` and `endUser`.
- **Unified `/v1` errors:** `{"error": {"type", "code", "message"}}` with a
  stable `code` (including 401s and rate limits).
- **Apps (optional tenants):** new `apps` table; agents and API keys get
  an optional `app_id`. Nothing changes until you create an app: existing
  and new agents and keys stay account-level, and an account-level `user`
  key still covers every agent of the account. Create apps (e.g.
  `douchat-prod`, `douchat-dev`) under API Keys → New app and pick one when
  issuing a key: that key only sees, creates and bills agents of its app —
  on `/v1` and on `/api/agents`. `GET /v1/usage?scope=app` counts the app's
  agents (the whole account for account-level keys). Console endpoints:
  `GET/POST /api/apps`, `PATCH/DELETE /api/apps/{id}`.
- **On-demand agent loading:** accounts with more than 50 agents
  (`FASTCLAW_EAGER_AGENT_LIMIT`) load agents on first use and drop idle ones.
  Agents bound to IM channels or with enabled cron jobs are still loaded at
  startup and never dropped, and cron/channel/webhook dispatch attaches any
  agent it needs. Smaller accounts load exactly as before.

### Added — personal skills

Every account can now install skills for itself from `/console/skills`,
with the same search / install / zip upload / configure / remove flow as an
Agent's Skills page. They live in `~/.fastclaw/users/<uid>/skills/` (and the
object store) and load in all of that account's conversations, with any
agent. Skills installed for the whole deployment are listed as shared;
accounts can set their own credentials for them. API: `scope: "user"` on
`POST /api/skills/install`, `?scope=user` on `GET /api/skills`,
`POST /api/skills/upload` and `DELETE /api/skills/{name}`.

### Changed — management pages moved under `/console`

The web UI now has two areas: the chat (`/agents/<id>/chat/…`,
`/teams/…`, unchanged) and the console at `/console` for managing agents,
models, skills, tools, plugins, channels, cron and API keys. Per-agent
configuration pages moved from `/agents/<id>/<tab>` to
`/console/agents/<id>/<tab>`; `/overview` is now `/console`. Old URLs
(including `/agents/?manage=1`) redirect to their new location.

The console sidebar is one flat list of the account's own pages —
Overview, Agents, Models, Skills, Apps, API Keys — for every account.
Apps have their own page (`/console/apps`: create, rename, delete empty
apps); the API Keys page only picks an app when issuing a key.
`/console/models` and `/console/skills` show the caller's own (user-level)
configuration.

Super_admins manage the deployment from `/admin`, with its own sidebar: Users, Chats, Token Usage,
Models, Skills, Tools and About. These pages left the Settings dialog,
which now holds only personal preferences (Account, General).
`/console/tools` and `/tools` redirect to `/admin/tools/`.

A narrow rail on the far left switches between the areas: the FastClaw
logo on top, then Chat, Console, Admin (super_admins only), and at the
bottom Settings and the signed-in account (log out). Each area's sidebar
is titled with its name. Each area reopens
the page the user last had open there. After sign-in users return to the
area they were last in (their last conversation by default). Accounts
without agents land on `/console/agents/` to create one.

### Fixed

- `GET /v1/usage?user_id=` and the `/v1/quota` endpoints accepted any user
  ID. They now only accept the key's own account or one of its end-users
  (platform-admin keys excepted), returning `403 forbidden` otherwise.
- **Cron jobs fired ~hours late on Postgres when the server ran in a
  non-UTC timezone.** The `cron_jobs` time columns were declared
  `TIMESTAMP WITHOUT TIME ZONE`. A Go `time.Time` carrying a non-UTC
  offset (e.g. `Asia/Shanghai`) was written with its offset silently
  dropped, so a Beijing "09:00" job was stored as `09:00` and read back
  as `09:00 UTC` = `17:00 Beijing` — firing 8h late (or, in the opposite
  direction, never matching `next_run <= now()` at all). SQLite was
  unaffected. The columns are now `TIMESTAMPTZ`, which preserves the
  instant across write/read regardless of offset or session `TimeZone`.

### BREAKING — cron schedule state is reset on upgrade (Postgres only)

When a Postgres deployment runs the schema migration for the first time,
**every existing row in `cron_jobs` is deleted.** This is deliberate:
the stored `next_run` wall-clocks already carry the wrong timezone, so
converting them would freeze the bug into the new column type. A clean
reschedule is the correct recovery.

- **What is lost:** pending scheduled jobs (recurring `cron`, `interval`,
  and not-yet-fired `once` reminders).
- **What is NOT lost:** chat history (`sessions`, `session_messages`),
  agent identity files, provider/channel config — none of these are
  touched.
- **Operator action required:** after upgrading, any recurring schedule
  a user relies on (e.g. "every day at 9am") must be recreated by asking
  the agent again, or via the dashboard's Scheduler tab. The original
  `create_cron_job` tool calls are still visible in chat history and can
  serve as a reference for what to rebuild.
- **Visibility:** the gateway logs a single
  `level=WARN msg="resetting cron schedule state for timestamptz migration …"`
  line with the row count before wiping, so operators can tell from the
  upgrade log whether any jobs were affected.
- **SQLite deployments:** unaffected — the migration is skipped entirely.
- **Idempotent:** re-running the migration (e.g. on every daemon boot)
  is a no-op once the columns are already `timestamptz`.

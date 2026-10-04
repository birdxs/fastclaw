# FastClaw API Integration

Use this skill when integrating an upstream application with FastClaw as an
agent runtime.

The canonical reference is `docs/upstream-api.md` in the FastClaw repository.
Follow that document over guesses from existing dashboard code.

## Integration Boundary

FastClaw is the agent runtime; the upstream app owns its users, permissions,
billing, chat records and IM channels. The runtime never calls the app back.
Agents belong to the integrator's FastClaw account (and optionally to an
app such as `douchat-prod`), never to an end-user — the integrating app must
check "may this user use this agent?" before every call. For fixed agents an
account-level `agent` key scoped to them is enough; use apps to separate
environments or integrations that create their own agents.

Use `/v1/*` only:

- `POST/GET/PATCH/DELETE /v1/agents[/{id}]` to manage the app's agents;
  `PUT /v1/agents/{id}/system-files/{name}` for SOUL.md / IDENTITY.md / ….
- `POST /v1/chat/completions` for chat.
- `GET /v1/usage` for billing (`scope=app`, `agent_id`, `end_user`).
- `PUT /v1/quota`, `GET /v1/quota`, `DELETE /v1/quota` for paid-plan limits.
- `POST /v1/users` to provision end-users up front (optional).

`/api/*` serves FastClaw's own console and has no stability promise.

## Required Inputs

Before writing integration code, identify:

- FastClaw base URL.
- API key, stored server-side only.
- Whether agents are created per user (`POST /v1/agents`) or fixed.
- Upstream stable user ID field.
- Upstream conversation/session ID field.
- Whether usage/quota billing must be wired.
- Whether attachments/images must be supported.

Do not expose FastClaw API keys to browsers or mobile clients. Route calls
through the upstream backend.

## Chat Contract

Call:

```http
POST /v1/chat/completions
Authorization: Bearer <FASTCLAW_API_KEY>
Content-Type: application/json
X-Fastclaw-Session-Key: <deterministic-session-key>
```

Body:

```json
{
  "agent_id": "agt_...",
  "stream": true,
  "user": "upstream-user-id",
  "messages": [
    { "role": "user", "content": "..." }
  ],
  "params": {}
}
```

Rules:

- `agent_id` selects the FastClaw agent. Body wins over
  `X-Fastclaw-Agent-ID`. It is strict: an agent outside the app returns
  `404` with `error.code = "agent_not_found"` — there is no fallback.
- `user` is the upstream stable user ID. Body wins over
  `X-Fastclaw-End-User`. It only selects where session history, USER.md and
  personal memory live; it never changes which agents are usable. Omit it
  when the agent's memory should be shared (a user's own agent, group chats).
- In group chats, send the current speaker as
  `params.speaker = {"id": "...", "name": "..."}`; it is turn context only.
- `X-Fastclaw-Session-Key` controls conversation history. Use a deterministic
  key such as `<app>:<user-id>:<conversation-id>`.
- `params` is per-turn structured context. It is shown to the agent but not
  persisted.
- Use `images` or `imageUrls` for image URLs/data URLs intended for vision
  models.
- Use `attachments` for general files, with optional `name`.

## User Provisioning

Either explicitly provision:

```http
POST /v1/users
Authorization: Bearer <FASTCLAW_API_KEY>
Content-Type: application/json

{
  "external_id": "upstream-user-id",
  "display_name": "Optional Display Name"
}
```

Or skip provisioning and pass `user` on every chat call. FastClaw will lazy
create the app-user for that API key.

Store the returned `user_id` if the upstream app needs usage/quota lookups.

## Usage And Quota

Query usage (each daily row has `agentId` and `endUser`):

```http
GET /v1/usage?scope=app&days=30
GET /v1/usage?end_user=upstream-user-id&agent_id=agt_...
Authorization: Bearer <FASTCLAW_API_KEY>
```

Set quota after subscription changes:

```http
PUT /v1/quota
Authorization: Bearer <FASTCLAW_API_KEY>
Content-Type: application/json

{
  "user_id": "u_...",
  "monthly_token_limit": 5000000,
  "monthly_request_limit": 10000,
  "reset_day": 1
}
```

## Implementation Checklist

1. Add server-side FastClaw client configuration:
   - base URL
   - API key
   - agent ID
2. Add or reuse upstream conversation IDs.
3. Map upstream user IDs to FastClaw `user` or `/v1/users`.
4. Implement streaming SSE parsing for `/v1/chat/completions`.
5. Persist or derive `X-Fastclaw-Session-Key` per conversation.
6. Add attachment support only if the product UI needs it.
7. Add `/v1/usage` and `/v1/quota` only if billing/paid limits are required.
8. Handle errors by `error.code` (stable), e.g. `invalid_request`,
   `unauthorized`, `forbidden`, `agent_not_found`, `rate_limited`,
   `not_configured`.

## Do Not

- Do not call dashboard `/api/chat/stream` for upstream app chat unless you are
  embedding FastClaw's own dashboard semantics.
- Do not put FastClaw API keys in frontend code.
- Do not use email/display name as the stable FastClaw `user` value.
- Do not reuse one session key across unrelated conversations.
- Do not rely on FastClaw for per-user access control between agents; the
  runtime only isolates apps from each other.
- Do not bind your users to FastClaw-hosted IM bots; run channels in your app.

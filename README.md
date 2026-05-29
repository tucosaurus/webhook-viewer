# 🪝 Webhook Viewer

A real-time webhook data viewer. Any HTTP request (any method, any path) sent to
the server is captured and streamed live to the browser dashboard.

- **Zero dependencies** — pure Node.js built-ins. No `npm install` needed.
- **Realtime** via Server-Sent Events (auto-reconnects).
- **Catch-all capture** — `GET`, `POST`, `PUT`, etc. to any path is logged.
- **In-memory ring buffer** — keeps the last `MAX_REQUESTS` (default 500).

## Run locally

```bash
npm start          # or: node server.js
```

Open http://localhost:3000 — that's the dashboard.

Send a webhook to **any other path**:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"signup","user":"ada"}'

curl "http://localhost:3000/anything?foo=bar"
```

It appears in the dashboard instantly.

## How routing works

| Path | Purpose |
|------|---------|
| `/` | Dashboard UI |
| `/__events` | SSE stream (internal) |
| `/__api/requests` | History on load (internal) |
| `/__api/clear` | Clear buffer (internal) |
| **everything else** | Captured as a webhook |

Internal routes are prefixed with `/__` so they never collide with real webhooks.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service**, point it at the repo.
3. Render auto-detects `render.yaml`. (Or set Build Command empty, Start Command `node server.js`.)
4. Your webhook URL becomes `https://<your-app>.onrender.com/webhook`.

> ⚠️ Render's free tier has an **ephemeral filesystem** and **spins down when idle**,
> so captured requests are cleared on restart — that's why this uses in-memory storage.

## Access protection

The **viewer** (dashboard, SSE stream, history/clear APIs) can be locked behind a
shared token. **Webhook capture stays public** — external senders can't add auth
headers, so the catch-all must remain open.

Set `VIEWER_TOKEN`:

```bash
VIEWER_TOKEN="some-long-random-secret" npm start
```

- Visiting `/` shows a **login page**; enter the token to get in.
- The server validates with a constant-time compare and sets an **httpOnly session
  cookie** (cookies auto-attach to the SSE stream, which can't send custom headers).
- Sessions live in memory and clear on restart — users just log in again.
- A **Sign out** button is in the dashboard header.
- If `VIEWER_TOKEN` is **unset**, the viewer runs open (logs a warning).

On Render, set `VIEWER_TOKEN` as a secret env var in the dashboard (it's marked
`sync: false` in `render.yaml`).

## Config

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `3000` | Listen port (Render sets this automatically) |
| `MAX_REQUESTS` | `500` | Max requests kept in memory |
| `MAX_BODY_BYTES` | `1048576` | Per-request body size cap (1 MB) |
| `VIEWER_TOKEN` | _(unset)_ | Shared secret to access the dashboard. Unset = open. |

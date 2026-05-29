"use strict";

// Zero-dependency webhook data viewer.
// Captures any HTTP request (any method, any path) and streams it live to the UI.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 500);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1024 * 1024); // 1MB cap per request

// Shared-secret protection for the *viewer* (dashboard, SSE, history APIs).
// Webhook capture stays public so external senders can reach it.
// If VIEWER_TOKEN is unset, the viewer runs open (with a warning).
const VIEWER_TOKEN = process.env.VIEWER_TOKEN || "";
const AUTH_ENABLED = VIEWER_TOKEN.length > 0;
const sessions = new Set(); // valid session ids (cleared on restart)
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, "public", "login.html"));

// In-memory ring buffer of captured requests (newest first).
const captured = [];
// Connected SSE clients.
const clients = new Set();

const INDEX_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"));

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

// Attempt to parse the raw body into something structured for display.
function parseBody(raw, contentType) {
  const text = raw.toString("utf8");
  const ct = (contentType || "").toLowerCase();
  if (!text) return { kind: "empty", text: "", parsed: null };
  if (ct.includes("application/json")) {
    try {
      return { kind: "json", text, parsed: JSON.parse(text) };
    } catch {
      return { kind: "text", text, parsed: null };
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const parsed = {};
    for (const [k, v] of new URLSearchParams(text)) parsed[k] = v;
    return { kind: "form", text, parsed };
  }
  // Heuristic: try JSON even without the header.
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", text, parsed: JSON.parse(trimmed) };
    } catch {
      /* fall through */
    }
  }
  return { kind: "text", text, parsed: null };
}

function captureRequest(req, rawBody) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = v;

  const event = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query,
    headers: req.headers,
    ip: clientIp(req),
    size: rawBody.length,
    body: parseBody(rawBody, req.headers["content-type"]),
  };

  captured.unshift(event);
  if (captured.length > MAX_REQUESTS) captured.length = MAX_REQUESTS;
  broadcast({ type: "request", request: event });
  return event;
}

// ---- Auth helpers ----
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  const sid = parseCookies(req)["wv_sid"];
  return sid != null && sessions.has(sid);
}

function readBody(req, cb) {
  const chunks = [];
  let total = 0;
  req.on("data", (c) => {
    total += c.length;
    if (total > MAX_BODY_BYTES) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => cb(Buffer.concat(chunks)));
  req.on("error", () => cb(Buffer.alloc(0)));
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // ---- Auth endpoints ----
  if (pathname === "/__api/login" && req.method === "POST") {
    readBody(req, (raw) => {
      let token = "";
      try {
        token = JSON.parse(raw.toString("utf8")).token || "";
      } catch {
        /* ignore */
      }
      if (!AUTH_ENABLED || safeEqual(token, VIEWER_TOKEN)) {
        const sid = crypto.randomUUID();
        sessions.add(sid);
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `wv_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        sendJson(res, 401, { ok: false, error: "Invalid token" });
      }
    });
    return;
  }

  if (pathname === "/__api/logout" && req.method === "POST") {
    const sid = parseCookies(req)["wv_sid"];
    if (sid) sessions.delete(sid);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "wv_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- Dashboard UI ----
  if (req.method === "GET" && pathname === "/") {
    if (!isAuthed(req)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LOGIN_HTML);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }

  // ---- Internal API (prefixed with /__ so it never collides with webhooks) ----
  if (pathname === "/__api/requests" && req.method === "GET") {
    if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    sendJson(res, 200, { requests: captured, max: MAX_REQUESTS });
    return;
  }

  if (pathname === "/__api/clear" && req.method === "POST") {
    if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    captured.length = 0;
    broadcast({ type: "clear" });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- SSE stream ----
  if (pathname === "/__events" && req.method === "GET") {
    if (!isAuthed(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    res.write(`data: ${JSON.stringify({ type: "hello", count: captured.length })}\n\n`);
    clients.add(res);

    const keepAlive = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  // ---- Everything else = a captured webhook ----
  const chunks = [];
  let total = 0;
  let aborted = false;

  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      aborted = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (aborted) return;
    captureRequest(req, Buffer.concat(chunks));
    sendJson(res, 200, { ok: true, message: "Webhook received" });
  });

  req.on("error", () => {
    if (!res.headersSent) sendJson(res, 400, { ok: false });
  });
});

server.listen(PORT, () => {
  console.log(`Webhook viewer running on http://localhost:${PORT}`);
  console.log(`Dashboard: /   |   Send webhooks to any other path (e.g. /webhook)`);
  if (AUTH_ENABLED) {
    console.log(`Viewer auth: ENABLED (VIEWER_TOKEN set)`);
  } else {
    console.warn(`⚠ Viewer auth: DISABLED — set VIEWER_TOKEN to protect the dashboard.`);
  }
});

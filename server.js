'use strict';

/**
 * NexLoop V0 — HTTP server.
 *
 *   GET  /             minimal interactive test bench (public/index.html)
 *   GET  /manifest.webmanifest, /icons/*   PWA assets (phone home-screen app)
 *   GET  /api/stream   Server-Sent Events: PLAN_CREATED / UNIT_SCHEDULED /
 *                      MESSAGE_SENT / UNIT_HELD / PLAN_COMPLETED /
 *                      USER_INTERRUPT / PLAN_CANCELLED / REPLAN_STARTED /
 *                      USER_MESSAGE / MODEL_ERROR / MEMORY_LOADED
 *   POST /api/chat     {message} → cancel active plan (if any), commit the user
 *                      message, generate + start a new plan
 *   GET  /api/history  committed history + active plan snapshot + memory
 *   GET  /api/timing   current pacing preset (companion|demo|instant|scripted)
 *   POST /api/timing   {preset} → switch pacing at runtime
 *
 * Memory: conversation + profile persist to ./memory (NEXLOOP_MEMORY_DIR),
 * restored on boot, auto-saved debounced on every mutation, flushed on exit.
 *
 * Zero runtime dependencies. Start with `node server.js`.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NexLoopEngine } = require('./engine');
const { createOpenAIProvider, createDemoProvider } = require('./providers');
const { TimingStrategy } = require('./timing');
const { MemoryStore } = require('./memory');

/* ---------------- tiny .env loader (real env vars win) ---------------- */
function loadDotEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch (_) {
    /* ignore */
  }
}

/* ---------------- config ---------------- */
loadDotEnv(); // load .env first (real env vars still win)

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 3000;

// Default (auto): a real model whenever an API key is configured; otherwise a
// zero-config deterministic demo fixture so the app runs with no setup.
// A configured real model always wins — it is never silently replaced by a demo.
const hasKey = Boolean(process.env.NEXLOOP_API_KEY || process.env.OPENAI_API_KEY);
const MODE = (process.env.NEXLOOP_MODE || (hasKey ? 'openai' : 'demo')).toLowerCase();

function buildProvider() {
  if (MODE === 'demo') return createDemoProvider();
  if (MODE === 'openai' || MODE === 'auto') {
    if (!hasKey) {
      throw new Error(
        'NEXLOOP_API_KEY is required for openai mode. ' +
        'Configure it in .env, or leave NEXLOOP_MODE unset to run the zero-config demo.'
      );
    }
    return createOpenAIProvider({
      apiKey: process.env.NEXLOOP_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: process.env.NEXLOOP_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.NEXLOOP_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      jsonMode: process.env.NEXLOOP_JSON_MODE !== 'false',
    });
  }
  throw new Error(`unknown NEXLOOP_MODE '${MODE}' (use 'openai' or 'demo')`);
}

/** Parse a "lo,hi" ms range env var → [lo,hi] or null. */
function parseRange(v) {
  if (!v) return null;
  const p = String(v).split(',').map(Number);
  if (p.length !== 2 || p.some((x) => !Number.isFinite(x) || x < 0)) return null;
  return [p[0], p[1]];
}

// Pacing strategy. Default: companion (the product). Demo: compressed ranges
// for a 30s phone demo. Instant: the OFF switch (classic immediate chat).
const TIMING_PRESET = process.env.NEXLOOP_TIMING_PRESET || 'companion';
const timingOverrides = {
  first: parseRange(process.env.NEXLOOP_TIMING_FIRST_MS),
  middle: parseRange(process.env.NEXLOOP_TIMING_MIDDLE_MS),
  hold: parseRange(process.env.NEXLOOP_TIMING_HOLD_MS),
};

// Memory layer: conversation + profile persisted to a folder, restored on boot,
// auto-saved on every mutation and flushed on clean exit.
const MEMORY_DIR = process.env.NEXLOOP_MEMORY_DIR || 'memory';
const memory = new MemoryStore({ dir: MEMORY_DIR });

const engine = new NexLoopEngine({
  provider: buildProvider(),
  timing: new TimingStrategy(TIMING_PRESET, { overrides: timingOverrides }),
  memory,
});
const sseClients = new Set();

engine.on('event', (ev) => {
  const frame = `event: ${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) {
    res.write(frame);
  }
});

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Serve a static file from public/ (safe: no traversal). */
function serveStatic(res, file, contentType) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    serveStatic(res, path.join(__dirname, 'public', 'manifest.webmanifest'), 'application/manifest+json');
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/icons/')) {
    const name = path.basename(url.pathname); // basename only → no path traversal
    if (!/\.png$/.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    serveStatic(res, path.join(__dirname, 'public', 'icons', name), 'image/png');
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const file = path.join(__dirname, 'public', 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('index.html missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const result = await engine.handleUserMessage(parsed.message);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: String((err && err.message) || err) });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    sendJson(res, 200, { ...engine.snapshot(), memory: engine.memorySnapshot() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/timing') {
    sendJson(res, 200, { preset: engine.timing.name });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/timing') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const name = engine.setTimingPreset(String(parsed.preset || '').toLowerCase());
        sendJson(res, 200, { preset: name });
      } catch (err) {
        sendJson(res, 400, { error: String((err && err.message) || err) });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`NEXLOOP_LISTENING http://${HOST}:${addr.port}`);
  console.log(`NEXLOOP_MODE ${MODE} (provider=${engine.provider.name})`);
  console.log(`NEXLOOP_TIMING ${engine.timing.name}`);
  console.log(`NEXLOOP_MEMORY ${memory.path} (${engine.committedHistory.length} messages restored)`);
  if (MODE === 'openai') {
    console.log(`NEXLOOP_MODEL ${process.env.NEXLOOP_MODEL || process.env.OPENAI_MODEL || '(default)'}`);
  } else {
    console.log('NEXLOOP_DEMO zero-config fixture — set NEXLOOP_API_KEY to use a real model');
  }
});

// Clean-exit memory flush: SIGINT (Ctrl-C / Render shutdown) and SIGTERM
// (orchestrators) both persist the conversation before the process dies.
function shutdown(signal) {
  console.log(`[nexloop] ${signal} received — saving memory…`);
  memory.flush();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

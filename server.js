'use strict';

/**
 * NexLoop V0 — HTTP server.
 *
 *   GET  /             minimal interactive test bench (public/index.html)
 *   GET  /api/stream   Server-Sent Events: PLAN_CREATED / MESSAGE_SENT /
 *                      PLAN_COMPLETED / USER_INTERRUPT / PLAN_CANCELLED /
 *                      REPLAN_STARTED / USER_MESSAGE / MODEL_ERROR
 *   POST /api/chat     {message} → cancel active plan (if any), commit the user
 *                      message, generate + start a new plan
 *   GET  /api/history  committed history + active plan snapshot
 *
 * Zero runtime dependencies. Start with `node server.js`.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NexLoopEngine } = require('./engine');
const { createOpenAIProvider, createDemoProvider } = require('./providers');

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

const engine = new NexLoopEngine({ provider: buildProvider() });
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

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
    sendJson(res, 200, engine.snapshot());
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`NEXLOOP_LISTENING http://${HOST}:${addr.port}`);
  console.log(`NEXLOOP_MODE ${MODE} (provider=${engine.provider.name})`);
  if (MODE === 'openai') {
    console.log(`NEXLOOP_MODEL ${process.env.NEXLOOP_MODEL || process.env.OPENAI_MODEL || '(default)'}`);
  } else {
    console.log('NEXLOOP_DEMO zero-config fixture — set NEXLOOP_API_KEY to use a real model');
  }
});

'use strict';

/** Shared test helpers: spawn server, SSE client, HTTP utils, leak invariant. */

const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NEXLOOP_MODE: 'mock', PORT: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let settled = false;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/NEXLOOP_LISTENING (https?:\/\/[^\s]+)/);
      if (m && !settled) {
        settled = true;
        resolve({
          url: m[1],
          close: () => child.kill('SIGTERM'),
          child,
        });
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server:stderr] ${d}`));
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`server exited early (code ${code})\n${buf}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error('server start timeout'));
      }
    }, 10000).unref();
  });
}

/**
 * Minimal SSE client. Resolves once the stream is open.
 * `events` is an array of {event, data} frames, appended live.
 */
function sseClient(baseUrl) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(baseUrl + '/api/stream', (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = { event: null, data: null };
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7).trim();
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
          }
          if (ev.event) events.push(ev);
        }
      });
      resolve({
        events,
        waitFor: (pred, timeoutMs = 8000) => waitFor(events, pred, timeoutMs),
        count: (name, planId) =>
          events.filter((e) => e.event === name && (!planId || e.data.plan_id === planId)).length,
      });
    });
    req.on('error', reject);
  });
}

function waitFor(events, pred, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `timeout after ${timeoutMs}ms; seen: ${events.map((e) => e.event).join(', ') || '(none)'}`
          )
        );
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function post(baseUrl, pathname, body) {
  const res = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getJson(baseUrl, pathname) {
  const res = await fetch(baseUrl + pathname);
  return res.json();
}

/** Message string that scripts the mock provider to return `plan`. */
function scripted(plan) {
  return '@@MOCK@@ ' + JSON.stringify(plan);
}

/**
 * THE race invariant, checked against a server-side event log:
 * once a plan is interrupted or cancelled, no message from it may ever be sent.
 */
function assertNoLeak(events) {
  const dead = new Set();
  for (const ev of events) {
    if ((ev.event === 'USER_INTERRUPT' || ev.event === 'PLAN_CANCELLED') && ev.data.plan_id) {
      dead.add(ev.data.plan_id);
    }
    if (ev.event === 'MESSAGE_SENT' && dead.has(ev.data.plan_id)) {
      throw new Error(`LEAK: dead plan ${ev.data.plan_id} sent a message after cancellation: ${JSON.stringify(ev)}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, sseClient, post, getJson, scripted, assertNoLeak, sleep, ROOT };

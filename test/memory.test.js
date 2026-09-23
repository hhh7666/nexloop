'use strict';

/**
 * Memory layer tests — "it remembers you".
 *
 *  - MemoryStore: save → load round-trip, corrupt-file tolerance, atomic flush.
 *  - extractProfile: light user-name extraction from conversation.
 *  - Integration: a conversation survives a server restart via the memory
 *    folder (SIGTERM flushes; boot re-reads).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore, extractProfile } = require('../memory');
const { NexLoopEngine } = require('../engine');
const { TimingStrategy } = require('../timing');
const { createDemoProvider } = require('../providers');
const { startServer, sseClient, post, getJson, scripted, sleep } = require('./helpers');

test('MemoryStore round-trips history through the memory folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexloop-mem-'));
  const mem = new MemoryStore({ dir, debounceMs: 10 });
  mem.data.history = [{ role: 'user', content: 'hi', ts: 't1' }];
  mem.data.profile = { name: '小美' };
  mem.flush();

  const mem2 = new MemoryStore({ dir });
  const loaded = mem2.load();
  assert.equal(loaded.history.length, 1);
  assert.equal(loaded.history[0].role, 'user');
  assert.equal(loaded.history[0].content, 'hi');
  assert.equal(loaded.profile.name, '小美');
  assert.equal(loaded.version, 1);
});

test('MemoryStore tolerates a corrupt memory file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexloop-mem-'));
  fs.writeFileSync(path.join(dir, 'memory.json'), '{{{ definitely not json');
  const mem = new MemoryStore({ dir });
  const loaded = mem.load();
  assert.deepEqual(loaded.history, []);
  assert.deepEqual(loaded.profile, {});
});

test('extractProfile picks up a name the user shared', () => {
  assert.equal(extractProfile([{ role: 'user', content: '你好，我叫小美' }]).name, '小美');
  assert.equal(extractProfile([{ role: 'user', content: '随便聊聊' }]).name, undefined);
});

test('engine learns and persists the user name via PROFILE_LEARNED', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexloop-mem-'));
  const memory = new MemoryStore({ dir, debounceMs: 5 });
  const engine = new NexLoopEngine({
    provider: createDemoProvider(),
    timing: new TimingStrategy('instant'),
    memory,
  });
  const events = [];
  engine.on('event', (e) => events.push(e.event));

  await engine.handleUserMessage('你好，我叫小美');
  await sleep(80); // debounce flush

  assert.ok(events.includes('PROFILE_LEARNED'), 'PROFILE_LEARNED emitted');
  assert.equal(memory.data.profile.name, '小美');

  // persisted to disk and re-readable
  const mem2 = new MemoryStore({ dir });
  mem2.load();
  assert.equal(mem2.data.profile.name, '小美');
});

test('memory survives a server restart (SIGTERM flush + boot restore)', async (t) => {
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexloop-mem-'));
  const env = { NEXLOOP_MEMORY_DIR: memDir };

  // First server: have one real conversation.
  const srv1 = await startServer(env);
  const sse1 = await sseClient(srv1.url);
  const msg = scripted({ messages: [{ text: 'hello-mem', delay_ms: 0 }] });
  await post(srv1.url, '/api/chat', { message: msg });
  await sse1.waitFor((e) => e.event === 'PLAN_COMPLETED');
  srv1.close(); // SIGTERM → server flushes memory
  await sleep(600); // allow the child to shut down + flush

  // Memory file must exist with the conversation.
  const file = path.join(memDir, 'memory.json');
  assert.ok(fs.existsSync(file), 'memory.json written on exit');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.history.length, 2); // user + assistant

  // Second server: history restored from the folder.
  const srv2 = await startServer(env);
  t.after(() => srv2.close());
  const h = await getJson(srv2.url, '/api/history');
  assert.deepEqual(
    h.committedHistory.map((m) => m.content),
    [msg, 'hello-mem'],
    'committed history restored after restart'
  );
  assert.equal(h.memory.history.length, 2, 'memory snapshot restored');
});

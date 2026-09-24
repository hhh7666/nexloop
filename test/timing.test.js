'use strict';

/**
 * Human-pacing tests — the "the AI has its own pace" layer.
 *
 * TEST H — companionship pacing: first reply is NOT instant, middle units are
 *          drawn live at send time, closing line is HELD until silence.
 * TEST I — interrupt clears the held closing line (no leak).
 * TEST J — instant switch OFF: everything delivered immediately, no hold.
 * TEST K — runtime pacing switch via /api/timing.
 *
 * Ranges are overridden via NEXLOOP_TIMING_*_MS so the tests stay fast while
 * exercising the exact same draw-at-send-time mechanics as production.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { startServer, sseClient, post, getJson, scripted, assertNoLeak, sleep } = require('./helpers');

const PACED = {
  NEXLOOP_TIMING_PRESET: 'demo',
  NEXLOOP_TIMING_FIRST_MS: '150,250',
  NEXLOOP_TIMING_MIDDLE_MS: '150,250',
  NEXLOOP_TIMING_HOLD_MS: '300,500',
};

/* ---------------------------------------------------------------- TEST H */

test('TEST H — companion pacing: live draws + held closing line', async (t) => {
  const srv = await startServer(PACED);
  t.after(() => srv.close());
  const sse = await sseClient(srv.url);

  const plan = { messages: [
    { text: 'm1', delay_ms: 0 },
    { text: 'm2', delay_ms: 0 },
    { text: 'm3', delay_ms: 0 },
  ] };
  const t0 = Date.now();
  const res = await post(srv.url, '/api/chat', { message: scripted(plan) });
  const planId = res.json.plan_id;

  // First unit is NOT instant — it draws a positive delay at send time.
  const sched1 = await sse.waitFor(
    (e) => e.event === 'UNIT_SCHEDULED' && e.data.plan_id === planId && e.data.index === 0
  );
  assert.ok(
    sched1.data.delay_ms >= 150 && sched1.data.delay_ms <= 250,
    `first unit drawn in [150,250], got ${sched1.data.delay_ms}`
  );

  const m1 = await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === planId && e.data.text === 'm1');
  const elapsedFirst = Date.now() - t0;
  assert.ok(elapsedFirst >= 150, `first reply is not instant (elapsed=${elapsedFirst}ms)`);

  // Middle unit also waited its own draw.
  const t1 = Date.now();
  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === planId && e.data.text === 'm2');
  assert.ok(Date.now() - t1 >= 150, 'middle unit waited its draw');

  // Closing line is HELD — m3 not sent yet.
  const held = await sse.waitFor((e) => e.event === 'UNIT_HELD' && e.data.plan_id === planId);
  assert.ok(held.data.hold_ms >= 300 && held.data.hold_ms <= 500, `hold drawn in [300,500], got ${held.data.hold_ms}`);
  assert.equal(
    sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === planId && e.data.text === 'm3').length,
    0,
    'm3 must not be sent while held'
  );

  // After silence, the held line fires and the plan completes.
  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === planId && e.data.text === 'm3');
  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === planId);

  const h = await getJson(srv.url, '/api/history');
  assert.deepEqual(h.committedHistory.map((m) => m.content), [scripted(plan), 'm1', 'm2', 'm3']);
  assert.equal(h.activePlan, null);

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST I */

test('TEST I — interrupt clears the held closing line', async (t) => {
  const srv = await startServer({
    ...PACED,
    NEXLOOP_TIMING_HOLD_MS: '5000,5000', // long hold so we can interrupt before it fires
  });
  t.after(() => srv.close());
  const sse = await sseClient(srv.url);

  const u1 = scripted({ messages: [
    { text: 'm1', delay_ms: 0 },
    { text: 'm2', delay_ms: 0 },
    { text: 'm3', delay_ms: 0 },
  ] });
  const res1 = await post(srv.url, '/api/chat', { message: u1 });
  const plan1 = res1.json.plan_id;

  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === plan1 && e.data.text === 'm2');
  const held = await sse.waitFor((e) => e.event === 'UNIT_HELD' && e.data.plan_id === plan1);
  assert.ok(held.data.hold_ms >= 5000, 'hold is long enough to interrupt');

  // User interrupts while m3 is held.
  const u2 = scripted({ messages: [{ text: 'n1', delay_ms: 0 }] });
  const res2 = await post(srv.url, '/api/chat', { message: u2 });
  const plan2 = res2.json.plan_id;

  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === plan2);
  await sleep(300); // grace: the 5s hold timer would have fired if not cleared

  // m3 from plan1 NEVER sent.
  assert.equal(
    sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === plan1 && e.data.text === 'm3').length,
    0,
    'held closing line must be voided on interrupt'
  );
  assert.ok(sse.events.some((e) => e.event === 'USER_INTERRUPT' && e.data.plan_id === plan1));

  const h = await getJson(srv.url, '/api/history');
  assert.deepEqual(h.committedHistory.map((m) => m.content), [u1, 'm1', 'm2', u2, 'n1']);

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST J */

test('TEST J — instant switch: everything delivered immediately, no hold', async (t) => {
  const srv = await startServer({ NEXLOOP_TIMING_PRESET: 'instant' });
  t.after(() => srv.close());
  const sse = await sseClient(srv.url);

  // Even model delays of 5s must be ignored in instant mode.
  const plan = { messages: [
    { text: 'm1', delay_ms: 5000 },
    { text: 'm2', delay_ms: 5000 },
    { text: 'm3', delay_ms: 5000 },
  ] };
  const t0 = Date.now();
  const res = await post(srv.url, '/api/chat', { message: scripted(plan) });
  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === res.json.plan_id);

  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1500, `instant delivered everything in ${elapsed}ms`);
  const sent = sse.events
    .filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === res.json.plan_id)
    .map((e) => e.data.text);
  assert.deepEqual(sent, ['m1', 'm2', 'm3']);
  assert.equal(sse.events.filter((e) => e.event === 'UNIT_HELD').length, 0, 'no hold in instant mode');

  const scheds = sse.events.filter((e) => e.event === 'UNIT_SCHEDULED' && e.data.plan_id === res.json.plan_id);
  assert.equal(scheds.length, 3);
  assert.ok(scheds.every((s) => s.data.delay_ms === 0 && !s.data.hold), 'all draws are 0 in instant mode');

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST K */

test('TEST K — runtime pacing switch via /api/timing', async (t) => {
  const srv = await startServer(); // helpers default to scripted
  t.after(() => srv.close());

  const before = await getJson(srv.url, '/api/timing');
  assert.equal(before.preset, 'scripted');

  const ok = await post(srv.url, '/api/timing', { preset: 'companion' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.preset, 'companion');

  const bad = await post(srv.url, '/api/timing', { preset: 'nope' });
  assert.equal(bad.status, 400);

  const after = await getJson(srv.url, '/api/timing');
  assert.equal(after.preset, 'companion');
  const h = await getJson(srv.url, '/api/history');
  assert.equal(h.timing, 'companion');
});

/* ---------------------------------------------------------------- TEST P */

test('TEST P — model-error fallback bypasses human pacing (sent immediately)', async (t) => {
  // Paced server (demo preset, compressed ranges): a normal first reply would
  // wait 150-250ms+ — the fallback error unit must NOT wait at all.
  const srv = await startServer(PACED);
  t.after(() => srv.close());
  const sse = await sseClient(srv.url);

  const t0 = Date.now();
  await post(srv.url, '/api/chat', { message: '@@MOCK@@ definitely not json {{{' });
  const errEv = await sse.waitFor((e) => e.event === 'MODEL_ERROR');
  assert.ok(errEv.data.plan_id);
  const sent = await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === errEv.data.plan_id);
  assert.ok(sent.data.text.startsWith('[model error]'), 'fallback unit sent');
  assert.ok(Date.now() - t0 < 1500, `fallback sent immediately despite pacing (${Date.now() - t0}ms)`);

  assertNoLeak(sse.events);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { startServer, sseClient, post, getJson, scripted, assertNoLeak, sleep } = require('./helpers');

/* ---------------------------------------------------------------- TEST A */

test('TEST A — normal flow: all units delivered in order, no interrupt', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);
  const plan = { messages: [
    { text: 'm1', delay_ms: 0 },
    { text: 'm2', delay_ms: 120 },
    { text: 'm3', delay_ms: 120 },
  ] };

  const res = await post(srv.url, '/api/chat', { message: scripted(plan) });
  assert.equal(res.status, 200);
  assert.ok(res.json.plan_id);

  const completed = await sse.waitFor((e) => e.event === 'PLAN_COMPLETED');
  assert.equal(completed.data.plan_id, res.json.plan_id);

  const sent = sse.events.filter((e) => e.event === 'MESSAGE_SENT');
  assert.deepEqual(sent.map((e) => e.data.text), ['m1', 'm2', 'm3']);
  assert.ok(sent.every((e) => e.data.plan_id === res.json.plan_id));

  const lifecycle = sse.events
    .filter((e) => ['PLAN_CREATED', 'MESSAGE_SENT', 'PLAN_COMPLETED'].includes(e.event))
    .map((e) => e.event);
  assert.deepEqual(lifecycle, ['PLAN_CREATED', 'MESSAGE_SENT', 'MESSAGE_SENT', 'MESSAGE_SENT', 'PLAN_COMPLETED']);

  assert.ok(!sse.events.some((e) => e.event === 'USER_INTERRUPT' || e.event === 'PLAN_CANCELLED'));

  const h = await getJson(srv.url, '/api/history');
  assert.deepEqual(h.committedHistory.map((m) => m.content), [scripted(plan), 'm1', 'm2', 'm3']);
  assert.equal(h.activePlan, null);

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST B */

test('TEST B — interrupt mid-flow: remaining units never sent, replan from new state', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);

  const u1 = scripted({ messages: [
    { text: 'm1', delay_ms: 0 },
    { text: 'm2', delay_ms: 150 },
    { text: 'm3', delay_ms: 500 },
    { text: 'm4', delay_ms: 500 },
  ] });
  const res1 = await post(srv.url, '/api/chat', { message: u1 });
  const plan1 = res1.json.plan_id;

  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.text === 'm2');

  const u2 = scripted({ messages: [
    { text: 'n1', delay_ms: 0 },
    { text: 'n2', delay_ms: 120 },
  ] });
  const res2 = await post(srv.url, '/api/chat', { message: u2 });
  const plan2 = res2.json.plan_id;
  assert.notEqual(plan2, plan1);

  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === plan2);

  const sent = sse.events.filter((e) => e.event === 'MESSAGE_SENT').map((e) => e.data);
  const texts = sent.map((d) => d.text);
  assert.ok(!texts.includes('m3') && !texts.includes('m4'), 'm3/m4 must NEVER be sent');

  // interruption observability
  const interrupt = sse.events.find((e) => e.event === 'USER_INTERRUPT');
  assert.ok(interrupt, 'USER_INTERRUPT must be logged');
  assert.equal(interrupt.data.plan_id, plan1);
  const cancelled = sse.events.find((e) => e.event === 'PLAN_CANCELLED' && e.data.plan_id === plan1);
  assert.ok(cancelled, 'PLAN_CANCELLED for old plan must be logged');
  assert.equal(cancelled.data.reason, 'user_interrupt');

  // history: only REALLY delivered messages + the new user message
  const h = await getJson(srv.url, '/api/history');
  assert.deepEqual(h.committedHistory.map((m) => m.content), [u1, 'm1', 'm2', u2, 'n1', 'n2']);

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST C */

test('TEST C — early interrupt right after first unit', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);
  const u1 = scripted({ messages: [
    { text: 'm1', delay_ms: 0 },
    { text: 'm2', delay_ms: 2000 },
    { text: 'm3', delay_ms: 2000 },
  ] });
  const res1 = await post(srv.url, '/api/chat', { message: u1 });
  const plan1 = res1.json.plan_id;

  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.text === 'm1');

  const u2 = scripted({ messages: [{ text: 'n1', delay_ms: 0 }] });
  const res2 = await post(srv.url, '/api/chat', { message: u2 });
  const plan2 = res2.json.plan_id;

  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === plan2);
  await sleep(300); // grace: old 2s timers would have fired if not cancelled

  const plan1sends = sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === plan1);
  assert.deepEqual(plan1sends.map((e) => e.data.text), ['m1'], 'only m1 from plan1, ever');

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST D */

test('TEST D — repeated interrupts: no obsolete plan can resume', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);

  // plan1 sends m1 (delay 0) then nothing else before the interrupt storm
  const p1 = await post(srv.url, '/api/chat', { message: scripted({ messages: [
    { text: 'm1', delay_ms: 0 }, { text: 'm2', delay_ms: 600 }, { text: 'm3', delay_ms: 600 }, { text: 'm4', delay_ms: 600 },
  ] }) });
  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.text === 'm1');

  // rapid sequential interrupts — all intermediate plans have delay >= 600ms
  const p2 = await post(srv.url, '/api/chat', { message: scripted({ messages: [
    { text: 'n1', delay_ms: 600 }, { text: 'n2', delay_ms: 600 },
  ] }) });
  const p3 = await post(srv.url, '/api/chat', { message: scripted({ messages: [
    { text: 'o1', delay_ms: 600 }, { text: 'o2', delay_ms: 600 },
  ] }) });
  const p4 = await post(srv.url, '/api/chat', { message: scripted({ messages: [
    { text: 'f1', delay_ms: 0 }, { text: 'f2', delay_ms: 120 },
  ] }) });

  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === p4.json.plan_id);
  await sleep(300);

  const sentByPlan = (pid) => sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === pid).map((e) => e.data.text);
  assert.deepEqual(sentByPlan(p1.json.plan_id), ['m1']);
  assert.deepEqual(sentByPlan(p2.json.plan_id), []);
  assert.deepEqual(sentByPlan(p3.json.plan_id), []);
  assert.deepEqual(sentByPlan(p4.json.plan_id), ['f1', 'f2']);

  // every cancelled plan logged
  for (const pid of [p1.json.plan_id, p2.json.plan_id, p3.json.plan_id]) {
    assert.ok(
      sse.events.some((e) => e.event === 'USER_INTERRUPT' && e.data.plan_id === pid),
      `USER_INTERRUPT for ${pid}`
    );
  }

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST E */

test('TEST E — race: interrupt exactly when the next unit is about to fire', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);
  // m1@0, m2@100, m3@300, m4@500 — interrupt lands ~200ms, right before m3.
  const u1 = scripted({ messages: [
    { text: 'm1', delay_ms: 0 }, { text: 'm2', delay_ms: 100 },
    { text: 'm3', delay_ms: 200 }, { text: 'm4', delay_ms: 200 },
  ] });
  const res1 = await post(srv.url, '/api/chat', { message: u1 });
  const plan1 = res1.json.plan_id;

  await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.text === 'm2');
  await sleep(130); // ~30ms before m3 fires

  const u2 = scripted({ messages: [
    { text: 'n1', delay_ms: 0 }, { text: 'n2', delay_ms: 100 },
  ] });
  const res2 = await post(srv.url, '/api/chat', { message: u2 });
  const plan2 = res2.json.plan_id;

  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === plan2);
  await sleep(250); // grace window: m3/m4 timers would have fired by now if leaked

  const plan1sends = sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === plan1);
  assert.deepEqual(plan1sends.map((e) => e.data.text), ['m1', 'm2'], 'old plan must not leak m3/m4');
  assert.ok(sse.events.some((e) => e.event === 'USER_INTERRUPT' && e.data.plan_id === plan1));

  assertNoLeak(sse.events);
});

/* ---------------------------------------------------------------- TEST F */

test('TEST F — invalid model output: MODEL_ERROR + fallback, server stays alive', async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);
  const res = await post(srv.url, '/api/chat', { message: '@@MOCK@@ this is definitely not json {' });

  const errEv = await sse.waitFor((e) => e.event === 'MODEL_ERROR');
  assert.equal(errEv.data.plan_id, res.json.plan_id);

  const fallback = await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === res.json.plan_id);
  assert.ok(fallback.data.text.startsWith('[model error]'), 'fallback unit must be sent');

  // server still healthy: history + a subsequent normal flow
  const h = await getJson(srv.url, '/api/history');
  assert.equal(h.committedHistory.length, 2); // bad message + fallback unit

  const ok = await post(srv.url, '/api/chat', { message: scripted({ messages: [{ text: 'back-on-track', delay_ms: 0 }] }) });
  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === ok.json.plan_id);

  assertNoLeak(sse.events);
});

/* ------------------------------------------------------------ TEST G (concurrency) */

test('TEST G — concurrent messages: only the newest generation may send', async (t) => {
  // Mock LLM takes 300ms, forcing all three calls to overlap in flight.
  const srv = await startServer({ NEXLOOP_MOCK_LLM_MS: '300' });
  t.after(() => srv.close());

  const sse = await sseClient(srv.url);
  const msgA = scripted({ messages: [{ text: 'a1', delay_ms: 0 }] });
  const msgB = scripted({ messages: [{ text: 'b1', delay_ms: 0 }] });
  const msgC = scripted({ messages: [{ text: 'c1', delay_ms: 0 }] });

  const [ra, rb, rc] = await Promise.all([
    post(srv.url, '/api/chat', { message: msgA }),
    post(srv.url, '/api/chat', { message: msgB }),
    post(srv.url, '/api/chat', { message: msgC }),
  ]);

  await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === rc.json.plan_id);

  const sent = sse.events.filter((e) => e.event === 'MESSAGE_SENT').map((e) => e.data.text);
  assert.deepEqual(sent, ['c1'], 'only the last request may deliver');

  // the two superseded plans must never have been created/sent
  assert.ok(sse.events.some((e) => e.event === 'PLAN_CANCELLED' && e.data.reason === 'superseded_before_start'));

  // all three user messages are real history; only c1 as assistant message
  const h = await getJson(srv.url, '/api/history');
  assert.deepEqual(h.committedHistory.map((m) => m.content), [msgA, msgB, msgC, 'c1']);

  assertNoLeak(sse.events);
});

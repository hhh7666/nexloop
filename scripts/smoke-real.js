'use strict';

/**
 * Real-model smoke test: drives NexLoop (already running on PORT) over HTTP.
 *
 *   U1 → model plans m1..mN → we interrupt right after the second unit
 *   → old plan must be cancelled → new plan for U2 must deliver.
 *
 * Usage: node scripts/smoke-real.js <baseUrl>
 */

const http = require('node:http');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

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
        waitFor: (pred, timeoutMs = 60000) =>
          new Promise((res2, rej) => {
            const start = Date.now();
            const tick = () => {
              const hit = events.find(pred);
              if (hit) return res2(hit);
              if (Date.now() - start > timeoutMs) return rej(new Error('timeout: ' + events.map((e) => e.event).join(',')));
              setTimeout(tick, 25);
            };
            tick();
          }),
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  const sse = await sseClient(BASE);
  console.log('[smoke] SSE connected to', BASE);

  const postChat = async (message) => {
    const res = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    return res.json();
  };

  // --- 1. normal flow: U1 ---
  console.log('\n[smoke] >>> U1: 用简单的分步建议回答“如何养成早睡习惯”');
  const r1 = await postChat('用简单的分步建议回答：如何养成早睡习惯？请分成几条消息说。');
  console.log('[smoke] U1 plan_id =', r1.plan_id);

  // wait for the FIRST message of plan1, then interrupt immediately —
  // any further units (m2..mN) must still be pending and get cancelled.
  const sent1 = await sse.waitFor((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === r1.plan_id && e.data.index === 0);
  console.log('[smoke]   plan1 m1 sent:', JSON.stringify(sent1.data.text).slice(0, 80));
  console.log('[smoke]   plan1 unit count:', sse.events.find((e) => e.event === 'PLAN_CREATED' && e.data.plan_id === r1.plan_id)?.data.unit_count);

  // --- 2. interrupt with U2 ---
  console.log('\n[smoke] >>> U2 (interrupt): 等等，直接告诉我今晚能做的一件小事');
  const r2 = await postChat('等等，直接告诉我今晚就能做的一件小事就好');
  console.log('[smoke] U2 plan_id =', r2.plan_id);

  // wait for new plan completion
  const done = await sse.waitFor((e) => e.event === 'PLAN_COMPLETED' && e.data.plan_id === r2.plan_id);
  console.log('[smoke] plan2 completed:', done.data.plan_id);

  await new Promise((r) => setTimeout(r, 800)); // grace: any leaked unit would fire

  // --- report ---
  const leak = sse.events.some(
    (e, i) =>
      e.event === 'MESSAGE_SENT' &&
      (sse.events.slice(0, i).some((p) => (p.event === 'USER_INTERRUPT' || p.event === 'PLAN_CANCELLED') && p.data.plan_id === e.data.plan_id))
  );
  console.log('\n[smoke] === EVENT LOG (first 25) ===');
  for (const ev of sse.events.slice(0, 25)) {
    console.log(
      String(ev.ts || '').slice(11, 23),
      ev.event.padEnd(15),
      ev.data.plan_id || '',
      ev.event === 'MESSAGE_SENT' ? JSON.stringify(ev.data.text).slice(0, 60) : ev.data.reason || ''
    );
  }
  const sentAfterInterrupt = sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === r1.plan_id);
  const interrupted = sse.events.some((e) => e.event === 'USER_INTERRUPT' && e.data.plan_id === r1.plan_id);
  console.log('\n[smoke] plan1 messages sent total:', sentAfterInterrupt.length, '(exactly m1 expected)');
  console.log('[smoke] plan2 messages sent total:', sse.events.filter((e) => e.event === 'MESSAGE_SENT' && e.data.plan_id === r2.plan_id).length);
  console.log('[smoke] leak detected:', leak);
  console.log('[smoke] interrupted event logged:', interrupted);

  const h = await (await fetch(BASE + '/api/history')).json();
  console.log('\n[smoke] committed history:');
  for (const m of h.committedHistory) console.log('  ', m.role.padEnd(9), JSON.stringify(m.content).slice(0, 90));

  const plan1OnlyFirstUnit = sentAfterInterrupt.length === 1;
  if (leak || !interrupted || !plan1OnlyFirstUnit) {
    console.log('\n[smoke] RESULT: FAIL');
    process.exit(1);
  }
  console.log('\n[smoke] RESULT: PASS');
}

main().catch((e) => {
  console.error('[smoke] FAILED:', e.message);
  process.exit(1);
});

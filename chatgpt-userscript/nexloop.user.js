// ==UserScript==
// @name         NexLoop for ChatGPT
// @namespace    https://github.com/hhh7666/nexloop-gpt
// @version      0.1.0
// @description  Make ChatGPT talk like a human: split replies into short pieces, random pacing, interruptible mid-stream. No API key, no server.
// @author       Nova for Faryza
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * NexLoop for ChatGPT — the interaction layer lives in YOUR browser.
 *
 * Idea: ChatGPT writes a full reply at once. NexLoop intercepts that reply,
 * splits it into short pieces, and delivers them one at a time on a random,
 * human-like schedule — with a held closing line that only fires after you've
 * gone quiet. Interject any time: pending pieces are cancelled, never leaked.
 *
 * No backend, no API key, no account of our own.
 */

(function () {
  'use strict';

  // ---------- pacing presets (ported from V0 timing.js) ----------
  const PRESETS = {
    companion: {
      first: [60000, 120000],  // first piece: make the user wait like a human
      middle: [20000, 60000],  // middle pieces: irregular gaps
      hold:   [60000, 120000], // closing line: sent only after this much silence
    },
    demo: {
      first: [2000, 5000],
      middle: [3000, 7000],
      hold:   [6000, 10000],
    },
    instant: { first: [0, 0], middle: [0, 0], hold: [0, 0] }, // the OFF switch
  };

  let preset = localStorage.getItem('nexloop_preset') || 'demo';

  // ---------- cancellation-safe state machine (ported from V0 engine.js) ----------
  let generation = 0;       // monotonically increases; only the current gen may send
  let activeTimer = null;
  let processedMessages = new WeakSet();

  function clearPlan() {
    if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
  }

  function onUserSend() {
    generation++;          // invalidate every pending piece of the old plan
    clearPlan();
    log('USER_INTERRUPT gen=' + generation);
  }

  // ---------- helpers ----------
  const rand = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

  function schedule(i, n) {
    const p = PRESETS[preset];
    if (i === 0) return { delay: rand(p.first[0], p.first[1]), hold: false };
    if (i === n - 1) {
      return { delay: rand(p.middle[0], p.middle[1]), hold: true, holdMs: rand(p.hold[0], p.hold[1]) };
    }
    return { delay: rand(p.middle[0], p.middle[1]), hold: false };
  }

  function log(ev) {
    const line = '[' + new Date().toLocaleTimeString() + '] ' + ev;
    console.log('%cNexLoop%c ' + line, 'color:#f97316;font-weight:bold', 'color:inherit');
    const panel = document.getElementById('nexloop-log');
    if (panel) {
      const d = document.createElement('div');
      d.textContent = line;
      panel.appendChild(d);
      panel.scrollTop = panel.scrollHeight;
    }
  }

  function isStreamRunning() {
    return !!document.querySelector(
      '[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]'
    );
  }

  // Split a reply into short, human-length pieces.
  function splitIntoPieces(text) {
    const out = [];
    let buf = '';
    const push = () => {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
    };
    for (const ch of text) {
      buf += ch;
      if (ch === '\n') { push(); continue; }
      if ('。！？!?；;'.includes(ch)) push();
    }
    push();
    // collapse: keep pieces 1..220 chars
    return out.filter((s) => s.length > 0).slice(0, 8);
  }

  // ---------- delivery loop ----------
  function deliver(container, pieces) {
    const gen = ++generation;
    const n = pieces.length;
    log('PLAN_CREATED gen=' + gen + ' pieces=' + n);

    // clear the bubble, we will repopulate it ourselves
    container.innerHTML = '';
    container.dataset.nexl = 'active';

    function appendPiece(text, kind) {
      if (generation !== gen) { log('PLAN_CANCELLED (old gen woke up)'); return; }
      const p = document.createElement('div');
      p.textContent = text;
      p.style.marginBottom = '0.6em';
      if (kind === 'hold') p.style.opacity = '0.75';
      container.appendChild(p);
      log('MESSAGE_SENT gen=' + gen + ' (' + text.length + ' chars)');
    }

    function step(i) {
      if (generation !== gen) return; // superseded → drop silently
      if (i >= n) {
        container.dataset.nexl = 'done';
        log('PLAN_COMPLETED gen=' + gen);
        return;
      }
      const sched = schedule(i, n);
      log('UNIT_SCHEDULED gen=' + gen + ' i=' + i + ' delay=' + sched.delay + (sched.hold ? ' hold=' + sched.holdMs : ''));

      activeTimer = setTimeout(() => {
        if (generation !== gen) return;
        appendPiece(pieces[i], sched.hold ? 'hold' : 'normal');
        if (sched.hold) {
          // closing line: fire only after the user has been quiet for holdMs
          activeTimer = setTimeout(() => {
            if (generation !== gen) return;
            log('UNIT_HELD released');
            step(i + 1);
          }, sched.holdMs);
        } else {
          step(i + 1);
        }
      }, sched.delay);
    }
    step(0);
  }

  // ---------- intercept ChatGPT's completed replies ----------
  function findAssistantContainers() {
    // the last assistant message bubble(s). ChatGPT uses data-message-author-role.
    const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
    return Array.from(nodes);
  }

  function pickTextContainer(msgEl) {
    // inside an assistant message, the markdown/prose container holds the text
    return (
      msgEl.querySelector('.markdown.prose, .markdown, [class*="markdown"]') ||
      msgEl.querySelector('div.text-base') ||
      msgEl
    );
  }

  function processIfComplete() {
    if (isStreamRunning()) return;
    const nodes = findAssistantContainers();
    if (!nodes.length) return;
    const last = nodes[nodes.length - 1];
    if (processedMessages.has(last)) return;

    const container = pickTextContainer(last);
    const text = (container.innerText || '').trim();
    if (!text || text.length < 4) return;

    processedMessages.add(last);
    log('REPLY_CAPTURED (' + text.length + ' chars) → splitting');
    const pieces = splitIntoPieces(text);
    if (pieces.length < 2) { log('too short, leave as-is'); return; }
    deliver(container, pieces);
  }

  // ---------- observe the page ----------
  const mo = new MutationObserver(() => {
    // debounce: wait a tick for ChatGPT to finish rendering a mutation batch
    clearTimeout(processIfComplete._t);
    processIfComplete._t = setTimeout(processIfComplete, 800);
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------- intercept user sends (interrupt) ----------
  function isSendTarget(t) {
    return !!(
      t.closest('[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]') ||
      (t.closest('#prompt-textarea') && (t.key === 'Enter' && !t.shiftKey))
    );
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-testid="send-button"], button[aria-label*="Send"], button[aria-label*="发送"]')) {
      onUserSend();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'prompt-textarea' && e.key === 'Enter' && !e.shiftKey) {
      onUserSend();
    }
  }, true);

  // ---------- floating control bar ----------
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:99999',
    'display:flex', 'gap:6px', 'align-items:center',
    'background:#0b0b0f', 'color:#eee', 'padding:8px 10px',
    'border-radius:10px', 'font:12px/1.2 system-ui,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
  ].join(';');
  bar.innerHTML =
    '<span style="color:#f97316;font-weight:700">NexLoop</span>' +
    ['companion', 'demo', 'instant'].map((p) =>
      '<button data-p="' + p + '" style="padding:3px 8px;border-radius:6px;border:1px solid #333;background:#1a1a22;color:#ddd">' + p + '</button>'
    ).join('');
  document.body.appendChild(bar);

  function highlight() {
    bar.querySelectorAll('button[data-p]').forEach((b) => {
      const on = b.dataset.p === preset;
      b.style.background = on ? '#f97316' : '#1a1a22';
      b.style.color = on ? '#111' : '#ddd';
    });
  }
  bar.addEventListener('click', (e) => {
    const p = e.target && e.target.dataset && e.target.dataset.p;
    if (!p) return;
    preset = p;
    localStorage.setItem('nexloop_preset', p);
    highlight();
    log('TIMING_SWITCH ' + p);
  });
  highlight();

  // collapsible event log
  const logEl = document.createElement('div');
  logEl.id = 'nexloop-log';
  logEl.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:56px', 'z-index:99998',
    'width:300px', 'max-height:200px', 'overflow:auto',
    'background:rgba(11,11,15,.92)', 'color:#9fe', 'padding:8px',
    'border-radius:8px', 'font:10px/1.4 ui-monospace,monospace',
    'white-space:pre-wrap', 'display:none',
  ].join(';');
  document.body.appendChild(logEl);
  bar.querySelector('span').style.cursor = 'pointer';
  bar.querySelector('span').addEventListener('click', () => {
    logEl.style.display = logEl.style.display === 'none' ? 'block' : 'none';
  });

  log('NexLoop for ChatGPT loaded — preset=' + preset);
})();

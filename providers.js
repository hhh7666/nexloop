'use strict';

/**
 * Providers + structured-output parsing/validation.
 *
 * The model output is NEVER trusted as-is: parsePlanUnits() validates every
 * field, caps unit count / delays, and throws on anything malformed.
 * The OpenAI-compatible provider retries once with a corrective message;
 * the engine turns a final failure into MODEL_ERROR + a fallback unit.
 */

const { MAX_UNITS, MAX_DELAY_MS } = require('./engine');

const SYSTEM_PROMPT = [
  'You are NexLoop, an interaction layer that delivers a reply as a sequence of short messages.',
  'Given the conversation history, produce the next delivery plan as JSON ONLY.',
  'Rules:',
  '- Split your reply into 2-5 short, self-contained messages that build on each other.',
  '- Each message adds NEW content (never repeat earlier ones).',
  '- Order matters: messages are delivered in the given order.',
  '- The user may interrupt at any time, so put the most important content early.',
  '- The last message can be a light, open-ended line that keeps the conversation going.',
  '- DO NOT include delay_ms — NexLoop decides the timing.',
  'Reply with ONLY valid JSON, no markdown fences, no commentary:',
  '{"messages":[{"text":"..."},{"text":"..."}]}',
].join('\n');

/** Extract JSON from raw model output (handles markdown fences / stray text). */
function extractJson(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('empty model output');
  try {
    return JSON.parse(s);
  } catch (_) {
    // try to pull the first fenced or braced JSON blob
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch (_2) {
        /* fall through */
      }
    }
    const brace = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (brace !== -1 && end > brace) {
      try {
        return JSON.parse(s.slice(brace, end + 1));
      } catch (_3) {
        /* fall through */
      }
    }
    throw new Error('model output is not valid JSON');
  }
}

/** Validate + normalize a raw model output into delivery units. */
function parsePlanUnits(raw) {
  const data = extractJson(raw);
  if (!data || typeof data !== 'object') throw new Error('plan is not an object');
  if (!Array.isArray(data.messages) || data.messages.length === 0) {
    throw new Error('plan.messages must be a non-empty array');
  }

  const units = [];
  for (const item of data.messages) {
    if (!item || typeof item !== 'object') throw new Error('unit is not an object');
    if (typeof item.text !== 'string' || item.text.trim() === '') {
      throw new Error('unit.text must be a non-empty string');
    }
    let delay = 0;
    if (item.delay_ms !== undefined && item.delay_ms !== null) {
      delay = Number(item.delay_ms);
      if (!Number.isFinite(delay) || delay < 0) throw new Error(`invalid delay_ms: ${item.delay_ms}`);
    }
    units.push({
      text: item.text.trim(),
      delay_ms: Math.min(Math.round(delay), MAX_DELAY_MS),
    });
    if (units.length >= MAX_UNITS) break;
  }
  return units;
}

/**
 * OpenAI-compatible chat provider (works with OpenAI, local llama.cpp,
 * vLLM, Volcengine Ark, DeepSeek, Moonshot, etc. — anything that speaks
 * POST {base}/chat/completions).
 */
function createOpenAIProvider({
  apiKey,
  baseUrl,
  model,
  jsonMode = true,
  timeoutMs = 60000,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new Error('openai provider requires apiKey (NEXLOOP_API_KEY)');
  if (!baseUrl) throw new Error('openai provider requires baseUrl (NEXLOOP_BASE_URL)');
  if (!model) throw new Error('openai provider requires model (NEXLOOP_MODEL)');

  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  async function call(messages, { json } = {}) {
    const body = { model, messages, temperature: 0.7 };
    if (json) body.response_format = { type: 'json_object' };
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`LLM network error: ${String(err.message || err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('LLM returned empty content');
    }
    return content;
  }

  return {
    name: 'openai',
    async generatePlan(history, ctx = {}) {
      // Memory layer: every conversation turn re-reads memory and injects what
      // we remember about the user into the model context.
      let system = SYSTEM_PROMPT;
      const name = ctx.profile && ctx.profile.name;
      if (name) {
        system +=
          `\nMemory: the user told you their name is "${name}". Use it naturally, ` +
          `like a real companion would, but do not overuse it.`;
      }
      const messages = [{ role: 'system', content: system }, ...history];

      // json_mode first (best structured output). Some third-party OpenAI-
      // compatible proxies (e.g. api.newcoin.top) choke on response_format
      // json_object and reply with EMPTY content — so on an empty reply we
      // automatically retry WITHOUT json mode; extractJson still pulls the
      // JSON plan out of plain text. Self-healing, no config needed.
      let raw1;
      try {
        raw1 = await call(messages, { json: jsonMode });
      } catch (errEmpty) {
        if (!jsonMode || !/empty content/.test(String(errEmpty.message))) throw errEmpty;
        raw1 = await call(messages, { json: false });
      }
      try {
        return parsePlanUnits(raw1);
      } catch (err1) {
        // One corrective retry with explicit feedback.
        const retryMessages = [
          ...messages,
          { role: 'assistant', content: raw1 },
          {
            role: 'user',
            content:
              'Your previous reply was not valid JSON (reason: ' +
              String(err1.message) +
              '). Reply with ONLY valid JSON matching the exact schema. No markdown, no explanation.',
          },
        ];
        const raw2 = await call(retryMessages);
        return parsePlanUnits(raw2); // may throw → engine emits MODEL_ERROR + fallback
      }
    },
  };
}

/**
 * Zero-config demo fixture (no API key).
 *
 * Returns a realistic variable-length plan (3–6 units, drawn at plan time) so
 * the interaction loop (split → schedule → interrupt → replan, human pacing)
 * can be experienced with zero setup — and no two sessions feel scripted.
 *
 * If the user message starts with "@@MOCK@@ ", the rest is treated as raw model
 * output and run through the SAME parsePlanUnits() pipeline as a real model —
 * this is how the test suite scripts valid plans, invalid JSON, etc.
 */
function createDemoProvider() {
  return {
    name: 'demo',
    async generatePlan(history) {
      // Optional artificial latency so tests can force overlapping LLM calls.
      const llmMs = Number(process.env.NEXLOOP_MOCK_LLM_MS || 0);
      if (llmMs > 0) await new Promise((r) => setTimeout(r, llmMs));
      const last = [...history].reverse().find((m) => m.role === 'user');
      const text = last ? last.content : '';
      const m = text.match(/^@@MOCK@@\s*([\s\S]*)$/);
      if (m) {
        return parsePlanUnits(m[1]); // throws on invalid output → engine fallback
      }
      const count = 3 + Math.floor(Math.random() * 4); // 3–6 units
      const units = [];
      for (let i = 0; i < count; i++) {
        const unitText =
          i === 0
            ? `1/${count} · 收到：“${text}”。先说说我的想法——`
            : i === count - 1
              ? `${count}/${count} · 其实还有一点想补：我想听听你的看法。`
              : `${i + 1}/${count} · 接着往下说，第 ${i + 1} 点。`;
        units.push({ text: unitText, delay_ms: 0 });
      }
      return units;
    },
  };
}

module.exports = { createOpenAIProvider, createDemoProvider, parsePlanUnits, extractJson, SYSTEM_PROMPT };

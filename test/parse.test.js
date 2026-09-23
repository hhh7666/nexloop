'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parsePlanUnits, createDemoProvider } = require('../providers');

test('parses a valid plan and normalizes fields', () => {
  const units = parsePlanUnits(
    JSON.stringify({ messages: [
      { text: '  hello  ', delay_ms: '2500' },
      { text: 'second', delay_ms: 0.5 },
      { text: 'third' },
    ] })
  );
  assert.deepEqual(units, [
    { text: 'hello', delay_ms: 2500 },
    { text: 'second', delay_ms: 1 },
    { text: 'third', delay_ms: 0 },
  ]);
});

test('strips markdown fences and stray text', () => {
  const units = parsePlanUnits('Sure, here you go:\n```json\n{"messages":[{"text":"a","delay_ms":0}]}\n```\nhope that helps');
  assert.deepEqual(units, [{ text: 'a', delay_ms: 0 }]);
});

test('caps unit count and delay_ms', () => {
  const big = { messages: [] };
  for (let i = 0; i < 50; i++) big.messages.push({ text: `m${i}`, delay_ms: 999999 });
  const units = parsePlanUnits(JSON.stringify(big));
  assert.equal(units.length, 20);
  assert.ok(units.every((u) => u.delay_ms <= 30000));
});

test('throws on missing text, empty messages, invalid delay, non-JSON', () => {
  assert.throws(() => parsePlanUnits(JSON.stringify({ messages: [{ delay_ms: 5 }] })), /text/);
  assert.throws(() => parsePlanUnits(JSON.stringify({ messages: [] })), /messages/);
  assert.throws(() => parsePlanUnits(JSON.stringify({ messages: [{ text: 'x', delay_ms: -1 }] })), /delay/);
  assert.throws(() => parsePlanUnits(JSON.stringify({ messages: [{ text: 'x', delay_ms: 'abc' }] })), /delay/);
  assert.throws(() => parsePlanUnits('not json at all'), /JSON/);
  assert.throws(() => parsePlanUnits(''), /empty/);
});

test('demo provider default output is a valid variable-length plan (3-6 units)', async () => {
  const p = createDemoProvider();
  const units = await p.generatePlan([{ role: 'user', content: 'hi' }]);
  assert.ok(Array.isArray(units), 'must return an array');
  assert.ok(units.length >= 3 && units.length <= 6, `3-6 units, got ${units.length}`);
  assert.ok(units.every((u) => typeof u.text === 'string' && u.text.trim() !== ''), 'every unit has text');
  assert.ok(units.every((u) => Number.isFinite(u.delay_ms) && u.delay_ms >= 0), 'every unit has a valid delay_ms');
});

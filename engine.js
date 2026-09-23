'use strict';

/**
 * NexLoop V0 — core engine.
 *
 * Architecture rule:
 *   committed_history = messages the user REALLY sent + assistant messages REALLY sent.
 *   pending_plan      = messages the model planned but has NOT sent yet.
 *
 * Only an actually-delivered assistant message enters committed_history.
 * When the user sends a new message while a plan is delivering:
 *   pending_plan is cancelled, delivered messages stay, undelivered ones are voided,
 *   and a fresh plan is generated from the NEW committed history.
 */

const { EventEmitter } = require('node:events');
const { TimingStrategy } = require('./timing');

const MAX_UNITS = 20;
const MAX_DELAY_MS = 30000;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NexLoopEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{generatePlan(history: Array): Promise<Array<{text: string, delay_ms: number}>>}} opts.provider
   * @param {TimingStrategy} [opts.timing] pacing strategy (default: companion)
   */
  constructor({ provider, timing } = {}) {
    super();
    if (!provider || typeof provider.generatePlan !== 'function') {
      throw new Error('engine requires a provider with generatePlan()');
    }
    this.provider = provider;
    this.timing = timing || new TimingStrategy('companion');

    /** @type {Array<{role: 'user'|'assistant', content: string}>} */
    this.committedHistory = [];

    /** @type {null | {id: string, units: Array, status: 'active'|'cancelled'|'completed', deliveredCount: number, generation: number}} */
    this.activePlan = null;

    /** Monotonic counter: the newest user message always wins, even if an
     *  older LLM call is still in flight when a newer one arrives. */
    this.generation = 0;

    this.planSeq = 0;
  }

  /** Read-only snapshot for /api/history. */
  snapshot() {
    return {
      committedHistory: this.committedHistory.map((m) => ({ ...m })),
      activePlan: this.activePlan
        ? {
            id: this.activePlan.id,
            status: this.activePlan.status,
            unitCount: this.activePlan.units.length,
            delivered: this.activePlan.deliveredCount,
            generation: this.activePlan.generation,
          }
        : null,
      generation: this.generation,
      timing: this.timing.name,
    };
  }

  /** Runtime switch of the pacing strategy (companion | demo | instant | scripted). */
  setTimingPreset(preset) {
    this.timing.setPreset(preset);
    return this.timing.name;
  }

  /**
   * Emit an observability event (also broadcast to SSE clients by server.js).
   */
  emitEvent(event, meta = {}) {
    const payload = { ts: nowIso(), event, ...meta };
    this.emit('event', payload);
    return payload;
  }

  /**
   * Entry point for every user message.
   * If a plan is currently delivering, it is cancelled synchronously FIRST
   * (before any await), so a delivery loop that wakes up afterwards can never
   * pass its active-plan check.
   */
  async handleUserMessage(text) {
    const message = String(text ?? '').trim();
    if (!message) return { error: 'empty_message' };

    const generation = ++this.generation;

    // 1. Cancel the active plan (synchronous, atomic w.r.t. the delivery loop).
    const oldPlan = this.activePlan;
    if (oldPlan) {
      oldPlan.status = 'cancelled';
      if (oldPlan.holdTimer) {
        clearTimeout(oldPlan.holdTimer);
        oldPlan.holdTimer = null;
      }
      this.activePlan = null;
      this.emitEvent('USER_INTERRUPT', { plan_id: oldPlan.id, generation, message });
      this.emitEvent('PLAN_CANCELLED', { plan_id: oldPlan.id, reason: 'user_interrupt', generation });
    }

    // 2. The user message really happened — commit it now.
    this.committedHistory.push({ role: 'user', content: message });
    this.emitEvent('USER_MESSAGE', { generation, message });

    // 3. Generate the next plan from the CURRENT committed history.
    this.emitEvent('REPLAN_STARTED', { generation });
    const planId = `plan_${++this.planSeq}`;

    let units;
    try {
      units = await this.provider.generatePlan(this.committedHistory);
      if (!Array.isArray(units) || units.length === 0) {
        throw new Error('provider returned no units');
      }
    } catch (err) {
      const errMsg = String((err && err.message) || err);
      this.emitEvent('MODEL_ERROR', { plan_id: planId, generation, message: errMsg });
      units = [
        {
          text: `[model error] 暂时无法生成回复（${errMsg.slice(0, 200)}）。请稍后再试。`,
          delay_ms: 0,
        },
      ];
    }

    // 4. Superseded while generating? A newer request arrived — this plan must
    //    never be created, let alone send anything.
    if (this.generation !== generation) {
      this.emitEvent('PLAN_CANCELLED', { plan_id: planId, reason: 'superseded_before_start', generation });
      return { plan_id: planId, generation, superseded: true };
    }

    // 5. Create + start the plan (fire-and-forget delivery loop).
    const plan = {
      id: planId,
      units,
      status: 'active',
      deliveredCount: 0,
      generation,
    };
    this.activePlan = plan;
    this.emitEvent('PLAN_CREATED', { plan_id: planId, generation, unit_count: units.length });
    this.deliver(plan); // async, intentionally not awaited
    return { plan_id: planId, generation };
  }

  /**
   * Delivery loop. The ONLY place assistant messages are sent.
   *
   * Pacing: every unit draws its delay LIVE at send time from the timing
   * strategy (never a fixed schedule). The closing unit is HELD: it is not
   * sent immediately — an idle timer fires it only if the user stays silent.
   *
   * Race safety: between the active-plan check and the MESSAGE_SENT emit there
   * is no `await`, so a concurrent user message (which runs synchronously up to
   * its first await) cannot interleave in that window. An obsolete plan that
   * wakes up late simply checks `activePlan !== plan` and returns; a held-unit
   * timer is cleared synchronously on interrupt as a second line of defence.
   */
  async deliver(plan) {
    const n = plan.units.length;
    for (let i = 0; i < n; i++) {
      const unit = plan.units[i];
      const sched = this.timing.schedule(i, n, unit.delay_ms);
      this.emitEvent('UNIT_SCHEDULED', {
        plan_id: plan.id,
        generation: plan.generation,
        index: i,
        delay_ms: sched.delay_ms,
        hold: !!sched.hold,
        hold_ms: sched.hold_ms,
      });

      if (sched.hold) {
        // Closing line: hold. If the user goes quiet, fire it; if they
        // interrupt first, the timer is cleared and the line is voided.
        this.emitEvent('UNIT_HELD', {
          plan_id: plan.id,
          generation: plan.generation,
          index: i,
          hold_ms: sched.hold_ms,
        });
        plan.holdTimer = setTimeout(() => this._sendHeldUnit(plan, i), sched.hold_ms);
        return; // loop done — the idle timer owns the final send
      }

      if (sched.delay_ms > 0) {
        await sleep(sched.delay_ms);
      }
      if (this.activePlan !== plan || plan.status !== 'active') {
        return; // cancelled / superseded — do NOT send
      }
      this._sendUnit(plan, i);
    }
    if (this.activePlan === plan && plan.status === 'active') {
      plan.status = 'completed';
      this.activePlan = null;
      this.emitEvent('PLAN_COMPLETED', { plan_id: plan.id, generation: plan.generation });
    }
  }

  _sendUnit(plan, index) {
    const unit = plan.units[index];
    plan.deliveredCount += 1;
    this.committedHistory.push({ role: 'assistant', content: unit.text });
    this.emitEvent('MESSAGE_SENT', {
      plan_id: plan.id,
      generation: plan.generation,
      index,
      text: unit.text,
    });
  }

  /** The held closing line fires (only while the plan is still active). */
  _sendHeldUnit(plan, index) {
    if (this.activePlan !== plan || plan.status !== 'active') {
      return; // interrupted while holding — the line is void
    }
    plan.holdTimer = null;
    this._sendUnit(plan, index);
    plan.status = 'completed';
    this.activePlan = null;
    this.emitEvent('PLAN_COMPLETED', { plan_id: plan.id, generation: plan.generation });
  }
}

module.exports = { NexLoopEngine, MAX_UNITS, MAX_DELAY_MS };

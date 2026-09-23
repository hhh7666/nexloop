'use strict';

/**
 * NexLoop timing strategy — "the AI has its own pace".
 *
 * Two layers stay strictly separate:
 *   - WHAT to say  → the model (message units, content only)
 *   - WHEN to say  → this module (live random draws, never a fixed schedule)
 *
 * Presets:
 *   companion  — human-like pacing for everyday companionship:
 *                first reply 60–120s, middle 20–60s, and the closing line is
 *                HELD until the user has been silent 60–120s, then sent.
 *   demo       — the same mechanics with compressed ranges for a 30s demo:
 *                first 2–5s, middle 3–7s, hold fires after 6–10s silence.
 *   instant    — the OFF switch: everything is delivered immediately.
 *   scripted   — test/debug only: respect the model's own delay_ms, no hold.
 *
 * Every draw happens at send time (not at plan time), one fresh random value
 * per unit, so no two conversations ever feel the same — no machine rhythm.
 */

const PRESETS = {
  companion: { first: [60000, 120000], middle: [20000, 60000], hold: [60000, 120000] },
  demo: { first: [2000, 5000], middle: [3000, 7000], hold: [6000, 10000] },
  instant: { first: [0, 0], middle: [0, 0], hold: null },
  scripted: null, // model decides timing; no draws, no hold
};

function randInt(rng, [lo, hi]) {
  if (hi <= lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

class TimingStrategy {
  /**
   * @param {string} preset one of PRESETS
   * @param {object} [opts]
   * @param {function} [opts.rng] injectable random source (deterministic tests)
   * @param {object} [opts.overrides] per-range overrides, e.g.
   *        { first:[2000,5000], middle:[3000,7000], hold:[6000,10000] }
   */
  constructor(preset = 'companion', { rng = Math.random, overrides = null } = {}) {
    this.rng = rng;
    this.overrides = overrides;
    this.setPreset(preset);
  }

  setPreset(preset) {
    if (!(preset in PRESETS)) {
      throw new Error(`unknown timing preset '${preset}' (use ${Object.keys(PRESETS).join(', ')})`);
    }
    this.name = preset;
    this.ranges = PRESETS[preset];
  }

  _range(key) {
    const o = this.overrides && this.overrides[key];
    return o || this.ranges[key];
  }

  /**
   * Decide how the unit at `index` (0-based) of `unitCount` units is sent.
   * @returns {{delay_ms: number, hold: boolean, hold_ms?: number}}
   */
  schedule(index, unitCount, modelDelayMs) {
    if (this.ranges === null) {
      // scripted: the model owns the timing (tests, debugging)
      return { delay_ms: modelDelayMs, hold: false };
    }
    // A single-unit reply is the first reply — never held back entirely.
    if (index === unitCount - 1 && unitCount > 1 && this.ranges.hold) {
      // Closing line: hold, fire only after the user has been silent.
      return { delay_ms: 0, hold: true, hold_ms: randInt(this.rng, this._range('hold')) };
    }
    if (index === 0) {
      // First reply is NOT instant — the "not always available" feeling.
      return { delay_ms: randInt(this.rng, this._range('first')), hold: false };
    }
    return { delay_ms: randInt(this.rng, this._range('middle')), hold: false };
  }
}

module.exports = { TimingStrategy, PRESETS, randInt };

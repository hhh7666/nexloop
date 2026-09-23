'use strict';

/**
 * NexLoop memory layer — "it remembers you".
 *
 * A tiny file-backed store that keeps the conversation alive across restarts.
 *
 *   - Every time the engine mutates committed history, the store schedules a
 *     debounced save (so an instance killed mid-conversation still recovers).
 *   - On clean exit (SIGINT / SIGTERM) the store flushes synchronously.
 *   - Every conversation turn re-reads memory (history is injected into the
 *     model context; profile fields are injected into the system prompt).
 *
 * Format (memory/<file>):
 * {
 *   "version": 1,
 *   "updatedAt": "ISO",
 *   "history": [ { "role": "user"|"assistant", "content": "...", "ts": "ISO" } ],
 *   "profile": { "name": "..." | null }
 * }
 */

const fs = require('node:fs');
const path = require('node:path');

const MEMORY_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

class MemoryStore {
  /**
   * @param {object} opts
   * @param {string} [opts.dir] memory directory (default: ./memory)
   * @param {string} [opts.file] memory file name (default: memory.json)
   * @param {number} [opts.debounceMs] auto-save debounce (default: 500)
   */
  constructor({ dir = 'memory', file = 'memory.json', debounceMs = 500 } = {}) {
    this.dir = dir;
    this.file = file;
    this.path = path.join(dir, file);
    this.debounceMs = debounceMs;
    this._timer = null;
    this._dirty = false;

    this.data = {
      version: MEMORY_VERSION,
      updatedAt: null,
      history: [],
      profile: {},
    };
  }

  /** Read memory from disk (missing file → empty memory). */
  load() {
    try {
      if (!fs.existsSync(this.path)) return this.data;
      const raw = fs.readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return this.data;
      this.data.version = MEMORY_VERSION;
      this.data.updatedAt = parsed.updatedAt || null;
      this.data.history = Array.isArray(parsed.history)
        ? parsed.history.filter(
            (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
          )
        : [];
      this.data.profile = parsed.profile && typeof parsed.profile === 'object' ? parsed.profile : {};
      return this.data;
    } catch (err) {
      // Corrupt memory must never take the server down — start fresh.
      console.warn(`[memory] load failed (${err.message}); starting with empty memory`);
      return this.data;
    }
  }

  /** Replace the in-memory snapshot with a fresh one from disk (re-read every turn). */
  reload() {
    return this.load();
  }

  /** Schedule a debounced save (safe to call on every history mutation). */
  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) {
        this._dirty = false;
        this._saveNow();
      }
    }, this.debounceMs);
  }

  /** Synchronously persist now (used on clean exit; also flushes any pending debounce). */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._dirty = false;
    this._saveNow();
  }

  _saveNow() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      this.data.updatedAt = nowIso();
      const payload = JSON.stringify(this.data, null, 2);
      const tmp = this.path + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.path); // atomic-ish: a crash never leaves a half-written file
    } catch (err) {
      console.warn(`[memory] save failed: ${err.message}`);
    }
  }
}

/** Very light profile extraction: remember if the user tells us their name. */
function extractProfile(history) {
  const profile = {};
  for (const m of history) {
    if (m.role !== 'user') continue;
    const name = String(m.content).match(/(?:我叫|我是|可以叫我|叫我)([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})/);
    if (name && !profile.name) profile.name = name[1];
    if (profile.name) break;
  }
  return profile;
}

module.exports = { MemoryStore, extractProfile };

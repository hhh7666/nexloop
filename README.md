<div align="center">

# NexLoop

### *Your AI shouldn't end when the chat does.*

**A model-agnostic interaction layer** — we don't make models smarter, we change how their intelligence reaches you. NexLoop gives AI a **human pace**: it doesn't reply instantly, it thinks and sends in fits and starts, and it checks in when you go quiet.

[![tests](https://github.com/hhh7666/nexloop/actions/workflows/ci.yml/badge.svg)](https://github.com/hhh7666/nexloop/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D18.13-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-informational)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## The problem

AI waits until you speak — then tries to say everything at once. Every conversation today is a monologue disguised as dialogue.

Three fractures in every AI conversation:

1. **Communication is user-triggered.** The AI sits idle until you prompt it. It never initiates, never follows up, never checks in.
2. **Conversations are built around completed turns.** You ask, it answers, the exchange ends. There is no mid-thought correction, no interruption.
3. **The AI is always-on and instant.** It answers the moment you send — nothing like a person who reads, thinks, hesitates, and replies in their own time. Talking to it feels hollow because only *you* are ever proactive.

## The solution

NexLoop sits **between any model and you** — orchestrating *when* and *how* intelligence arrives, not *whether* it exists.

Instead of one monolithic response, a long reply becomes a **timed stream of short, interruptible messages**:

```
Traditional:  User → Model → Complete response  → User

NexLoop:      User → Model → m1 → wait → m2 → wait → m3 → ...
                                  └─ user interjects ─┐
                                                      ▼
                    pending queue CANCELLED, then REPLAN from the new state
```

## Four moves, one continuous loop

| | Move | What it does |
|---|---|---|
| **1** | **Split** | Break the model's reply into short, self-contained pieces. The model decides the content; NexLoop decides the timing. |
| **2** | **Schedule** | Deliver each piece in a human rhythm — the gap before every piece is **drawn at send time**, never a fixed timer. |
| **3** | **Interrupt** | Let the user stop, steer, or correct mid-flow. Pending pieces are cancelled. |
| **4** | **Replan** | Regenerate the *remaining* path around the new context. Already-delivered history is preserved. |

> The model never produces one long blob that we mechanically cut — it directly plans the next communication trajectory. And NexLoop never fakes timing with a fixed scheduler: the pacing comes from live random draws, so the AI *feels* like it's thinking as it goes.

## Architecture

The core rule: **committed history** (what really happened) is kept strictly separate from **pending plan** (what hasn't happened yet).

```
            ┌────────────────────────────────────────────┐
  user msg →│  cancel active plan (synchronously,        │
            │  before any await) → commit user message   │
            └───────────────────┬────────────────────────┘
                                ▼
                     model.generatePlan(history)
                                ▼
                  ┌────────────────────────┐
                  │  pending_plan (units) │  ← only the *active*
                  └───────────┬────────────┘     plan may send
                              ▼
                  check → sleep → check → send unit
                  (check→send with NO await between;
                   a stale plan can never leak a message)
```

**Concurrency safety** (the hard part):
- Every plan has a unique `plan_id`, plus a monotonically increasing `generation`.
- **Only the current active plan may send.** Each delivery does check-then-send with no `await` in between, so a concurrent request can never slip in.
- A user message cancels the active plan **synchronously**, before any network call — a stale async task that wakes up later simply fails its active check.
- When several LLM calls are in flight, `generation` guarantees only the newest request creates a plan; older ones are discarded (`superseded_before_start`).

**Model output is never trusted as-is** — every plan goes through `parsePlanUnits()`: field validation, unit/delay caps, markdown-fence stripping. On failure the provider retries once with corrective feedback; a final failure becomes `MODEL_ERROR` + a fallback unit. The server never crashes.

## Human pacing — "the AI has its own pace"

NexLoop deliberately does **not** reply instantly. Most AI feels hollow because only *you* are ever proactive. NexLoop gives the AI its own tempo:

- **No instant first reply.** The AI takes a while to respond — you see "typing…" while it "thinks" about what to say.
- **No fixed interval.** The gap before each message is **drawn at send time** (a fresh random value per message). Some pauses are short, some long — no machine rhythm, never the same twice.
- **A closing line is held.** The final message is not sent immediately: if you go quiet, the AI "checks in" with a light, open-ended line — so the conversation doesn't just die.

```
model output: [m1][m2][m3]            ← WHAT to say (the model)
NexLoop draw:  —2.4s— m1 —4.0s— m2 —hold 6.9s— m3   ← WHEN to say (the draws)
```

Pacing is a **product layer, not a model feature** — a configured real model still always wins; the pacing just decides when its messages arrive.

### Presets (switch at runtime in the UI, or via `POST /api/timing`)

| Preset | First reply | Middle gaps | Held closing line | Use |
|---|---|---|---|---|
| `companion` *(default)* | 60–120s | 20–60s | fires after 60–120s silence | everyday companionship |
| `demo` | 2–5s | 3–7s | after 6–10s silence | a 30-second phone demo |
| `instant` | 0 | 0 | none (sent immediately) | **OFF switch** — classic chat |
| `scripted` | model's own `delay_ms` | — | none | tests / debugging |

Every draw is a fresh random value at send time — never a fixed schedule. Ranges can be tuned via `NEXLOOP_TIMING_FIRST_MS` / `_MIDDLE_MS` / `_HOLD_MS` (e.g. `2000,5000`).

## Quickstart

**Zero dependencies, Node ≥ 18.13** (no `npm install`):

```bash
git clone https://github.com/hhh7666/nexloop.git
cd nexloop

node server.js          # zero-config: starts instantly in demo mode
```

Open <http://127.0.0.1:3000> and try it:
1. Send a message → the AI doesn't reply instantly; a "typing…" bubble appears, then the reply streams out in short pieces with irregular pauses.
2. Interject between pieces → the rest is cancelled (watch the event log: `USER_INTERRUPT` → `PLAN_CANCELLED`).
3. Let it go quiet → the held closing line fires on its own (watch `UNIT_HELD` → `MESSAGE_SENT`).
4. For a fast-paced walkthrough, switch the header toggle to **demo**; to get classic instant chat, switch to **即时 (instant)**.

### Plug in a real model

NexLoop is model-agnostic — any OpenAI-compatible endpoint (OpenAI, local llama.cpp, vLLM, Volcengine Ark, DeepSeek, Moonshot, …). Copy `.env.example` to `.env` and fill in:

```ini
NEXLOOP_API_KEY=...
NEXLOOP_BASE_URL=https://api.openai.com/v1
NEXLOOP_MODEL=gpt-4o-mini
```

A configured real model **always wins** over the demo fixture; if no key is present, it falls back to the zero-config demo. It never silently pretends a real model is configured.

## HTTP API

| Endpoint | Description |
|---|---|
| `GET /` | Minimal interactive console (committed history on the left, internal event log on the right) |
| `POST /api/chat` `{ "message": "..." }` | Cancel active plan → commit user message → generate + start a new plan |
| `GET /api/stream` | SSE event stream |
| `GET /api/history` | Committed history + active plan snapshot |
| `GET /api/timing` | Current pacing preset (`companion` / `demo` / `instant` / `scripted`) |
| `POST /api/timing` `{ "preset": "demo" }` | Switch pacing at runtime |

### Observability (every event carries `ts` + `plan_id`)

`PLAN_CREATED` · `UNIT_SCHEDULED` (each draw: `delay_ms`, `hold`, `hold_ms`) · `MESSAGE_SENT` · `UNIT_HELD` · `PLAN_COMPLETED` · `USER_INTERRUPT` · `PLAN_CANCELLED` · `REPLAN_STARTED` · `USER_MESSAGE` · `MODEL_ERROR`

## Tests

```bash
npm test        # node --test test/nexloop.test.js test/parse.test.js test/timing.test.js
```

All tests are real HTTP + SSE integration tests driven through the actual provider path against a deterministic in-process fixture.

| Case | Proves |
|---|---|
| TEST A | Normal flow — every piece delivered in order, no interrupt |
| TEST B | Interrupt mid-flow — pending pieces never sent; replan uses the new state |
| TEST C | Early interrupt — everything after the first piece is cancelled |
| TEST D | Repeated interrupts — no obsolete plan can resume |
| TEST E | Race condition — interrupt exactly when the next piece is due; no leakage |
| TEST F | Malformed model output — `MODEL_ERROR` + fallback; server stays alive |
| TEST G | Concurrent messages — only the newest generation may send |
| TEST H | Human pacing — first reply not instant, live draws, held closing line fires after silence |
| TEST I | Interrupt clears the held closing line (no leak) |
| TEST J | Instant switch — everything delivered immediately, no hold |
| TEST K | Runtime pacing switch via `/api/timing` |

Every test ends by asserting the **no-leak invariant**: once a plan is interrupted/cancelled, no `MESSAGE_SENT` from it may ever appear. CI runs the full suite on every push.

## Why this layer matters

Every user already has a preferred AI (ChatGPT, Claude, Gemini…). NexLoop **plugs into the models people already use** — no migration, no switching cost, no rip-and-replace. We don't compete with models; we complete them. The addressable market is every AI conversation, everywhere.

But the deepest problem isn't speed — it's that the AI never feels present. People who talk to AI often feel hollow because only *they* are proactive. NexLoop gives the AI a human rhythm: it doesn't always answer instantly, it spaces its messages unpredictably, and it reaches out when the conversation goes quiet. That emotional difference is the product.

**V0 status:** the interaction layer is implemented and verified — split → schedule → interrupt → replan with human pacing, strict history/plan separation, and provably cancellation-safe delivery. 16 integration tests pass on CI.

### Roadmap (next)
- **Affinity-driven pacing**: the drawn intervals shift with a "closeness" score (higher affinity → shorter waits), a hook for companion / otome-style experiences
- Persist pending plans so a page refresh resumes them
- Cross-session check-ins: the AI initiates when you've been away a long time

## License

MIT — see [LICENSE](LICENSE).

<div align="center">

# NexLoop

### *Your AI shouldn't end when the chat does.*

**A model-agnostic interaction layer** — we don't make models smarter, we change how their intelligence reaches you.

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
3. **Long-form responses arrive already obsolete.** By the time you finish reading a 500-word answer, your question may have shifted — but the AI already said it all.

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
| **1** | **Split** | Break the model's reply into digestible, self-contained pieces. The model plans them itself. |
| **2** | **Schedule** | Deliver each piece at the right moment (the model picks natural pacing). |
| **3** | **Interrupt** | Let the user stop, steer, or correct mid-flow. Pending pieces are cancelled. |
| **4** | **Replan** | Regenerate the *remaining* path around the new context. Already-delivered history is preserved. |

> The model never produces one long blob that we mechanically cut — it directly plans the next communication trajectory.

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

## Quickstart

**Zero dependencies, Node ≥ 18.13** (no `npm install`):

```bash
git clone https://github.com/hhh7666/nexloop.git
cd nexloop

node server.js          # zero-config: starts instantly in demo mode
```

Open <http://127.0.0.1:3000> and try it:
1. Send a message → the reply streams out as a few short pieces, paced over time.
2. Interject between pieces → the rest is cancelled (watch the event log: `USER_INTERRUPT` → `PLAN_CANCELLED`).
3. The model replans from the new conversation state and continues.

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

### Observability (every event carries `ts` + `plan_id`)

`PLAN_CREATED` · `MESSAGE_SENT` · `PLAN_COMPLETED` · `USER_INTERRUPT` · `PLAN_CANCELLED` · `REPLAN_STARTED` · `USER_MESSAGE` · `MODEL_ERROR`

## Tests

```bash
npm test        # node --test test/nexloop.test.js test/parse.test.js
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

Every test ends by asserting the **no-leak invariant**: once a plan is interrupted/cancelled, no `MESSAGE_SENT` from it may ever appear. CI runs the full suite on every push.

## Why this layer matters

Every user already has a preferred AI (ChatGPT, Claude, Gemini…). NexLoop **plugs into the models people already use** — no migration, no switching cost, no rip-and-replace. We don't compete with models; we complete them. The addressable market is every AI conversation, everywhere.

**V0 status:** the core interaction primitive is implemented and verified — split → schedule → interrupt → replan, with strict history/plan separation and provably cancellation-safe delivery.

### Roadmap (next)
- Explicit "stop / skip remaining" control in the UI
- Persist pending plans so a page refresh resumes them
- Adaptive pacing tuned per model

## License

MIT — see [LICENSE](LICENSE).

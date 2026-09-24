# NexLoop for ChatGPT

**Your AI shouldn't end when the chat does.** — but now it shouldn't answer instantly either.

NexLoop turns ChatGPT's instant wall-of-text into a **human conversation rhythm**:
a reply arrives in short pieces, on a random, irregular schedule, with a closing
line that only fires after *you* have gone quiet. Interject any time — pending
pieces are cancelled, never leaked.

This is the interaction layer from [NexLoop V0](https://github.com/hhh7666/nexloop),
but running **entirely in your browser** — no server, no API key, no account of our own.

---

## What it does

```
You send a message
   ↓
ChatGPT writes a full reply at once
   ↓
NexLoop intercepts it in the page, splits it into 2–8 short pieces
   ↓
Piece 1 waits a human-like delay (60–120s on companion, 2–5s on demo)
   ↓
Piece 2 … Piece 3 … irregular random gaps
   ↓
The LAST piece HOLDS — it only appears after you've been silent 60–120s
   ↓
If you interrupt at any point: everything still pending is cancelled forever
```

Three pacing presets (toggle with the floating **NexLoop** badge, bottom-right):

| Preset | First piece | Middle gaps | Held closing line |
|---|---|---|---|
| **companion** | 60–120 s | 20–60 s | holds 60–120 s of silence |
| **demo** *(default)* | 2–5 s | 3–7 s | holds 6–10 s |
| **instant** | 0 | 0 | off (classic ChatGPT) |

---

## Install on iPhone (3 steps, one-time)

1. **Install the free [Userscripts](https://apps.apple.com/app/userscripts/id1463298675) app** from the App Store.
2. Open **Userscripts** → tap the **+** → **Browse** → pick the downloaded
   `nexloop.user.js` (drop it into Files first). Enable the toggle for the script.
3. Open **iOS Settings → Apps → Safari → Extensions → Userscripts** → turn it **On**.
   Then in Safari, open [chatgpt.com](https://chatgpt.com) → tap the **Aa** icon
   (left of the address bar) → **Manage Extensions** → allow Userscripts.

You should see the orange **NexLoop** badge in the bottom-right corner of the chat.

> Android: use **Kiwi Browser** or **Firefox**, install Tampermonkey, then open
> `nexloop.user.js` — Tampermonkey offers to install it.

---

## How to test it

1. Open ChatGPT (any model), preset = **demo** first (fast feedback).
2. Ask for a long answer (e.g. "Write 3 short paragraphs about [your topic]").
3. Watch: instead of one wall of text, pieces appear one by one with pauses.
4. **Interrupt test:** while pieces are still coming, type something and hit send.
   → the remaining pieces vanish. Open the log (tap the orange "NexLoop" word)
   → you'll see `USER_INTERRUPT` → `PLAN_CANCELLED`.

Switch to **companion** when it feels right — that's the daily-use mode.

---

## How it works (in one breath)

A MutationObserver watches ChatGPT's assistant bubbles. When a reply finishes
(streaming stops, text stops changing), NexLoop grabs the full text, splits it
on Chinese/English sentence endings, clears the bubble, and repopulates it on a
random schedule. Every scheduled piece belongs to a monotonically increasing
*generation*; when you send a new message, the generation bumps and any old
timer that wakes up checks its generation, sees it's obsolete, and stays silent.
No pending piece can ever leak.

## Known limits

- ChatGPT's DOM changes occasionally. If a reply stops getting split, the
  selectors in `pickTextContainer` / `isStreamRunning` may need a small update.
- Code blocks and tables are split coarsely; this V0 focuses on prose chat.
- The first reply after page load is captured on the next mutation, so refresh
  once if nothing happens right away.

MIT.

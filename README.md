# Linkfy

Inbound LinkedIn automation. Someone comments a keyword on your post, and from
there: a public reply, a **personalized** connection invite, a qualified DM once
they accept, and follow-ups if they go quiet.

Everyone in this category ships the first half. The invite note — 300 characters
that decide whether you get accepted at all — is the part they send blank or not
at all. That is what this is for.

## Why a local agent

The panel is an ordinary web app. It never talks to LinkedIn, so it can live
anywhere. All LinkedIn activity runs through an **agent process on your own
machine**, driving a persistent Chrome profile.

```
┌──────────────────────┐              ┌────────────────────────┐
│  PANEL (cloud)       │   pull jobs  │  AGENT (your machine)  │
│  flows, contacts,    │ ───────────▶ │  Chrome + your session │
│  inbox, metrics      │ ◀─────────── │  your home IP          │
│  never touches       │    events    │  no UI, no inbound     │
│  LinkedIn            │              │  ports                 │
└──────────────────────┘              └────────────────────────┘
            └───────────── Postgres ─────────────┘
```

This is not a workaround, it is the design:

- **Your session cookie never leaves your disk.** The cookies-to-the-cloud model
  most tools use puts `li_at` — full account access, no password, no 2FA — on a
  vendor's server. `linkedin_accounts` deliberately has no column for it.
- **Actions originate from your IP**, not a datacenter.
- **Nothing is injected into LinkedIn's DOM**, unlike an extension.
- **No dependency on the Chrome Web Store**, which is a takedown lever a vendor
  does not control.

The trade-off is real and worth stating: with the machine off, nothing runs. The
queue holds in Postgres and the agent catches up on restart. For inbound that is
fine — replying two hours later still converts, and arguably reads better than
replying in four seconds.

## Layout

| Package | Status | What it is |
|---|---|---|
| `packages/core` | ✅ 72 tests | State machine, quotas, timing, playbook, orchestrator, safety rails. Pure, no I/O |
| `packages/db` | ✅ schema | Drizzle schema for Postgres (Supabase) |
| `packages/agent` | 🔨 24 tests | LLM layer, LinkedIn adapter interface, Chrome driver, history import |
| `apps/web` | ✅ 6 views | Next.js panel: inbox, pipeline, automations, dashboard, leads |

## The state machine

`packages/core/src/engine.ts` holds a single pure function, `decide()`, that
takes an enrollment plus a snapshot of the world and returns the next action. No
network, no browser — so the sequencing logic is testable on its own, which is
where the bugs that matter would otherwise hide.

```
detected ──▶ comment_replied ──┬─▶ (1st degree) ─────────────▶ dm_sent
                               │
                               └─▶ invite_queued ──▶ invite_sent
                                                          │
                                          accepted ──▶ connected ──▶ dm_sent
                                          21d silent ─▶ invite_expired

dm_sent ──3d──▶ followup_1_sent ──5d──▶ followup_2_sent ──▶ closed
   │
   └── they reply, at any point ──▶ replied   (outbound stops, playbook takes over)
```

## The conversation playbook

Once someone replies, `packages/core/src/playbook.ts` drives. It is a
transcription of how the account owner actually sells, not a generic sales bot:

```
qualifying_company   "tenes una empresa de tecnologia?"
        │ confirms
qualifying_pain      "estas en la busqueda de mas clientes?"
        │ shares_pain          ← they must name the problem themselves
pitching             short pitch + "te envío mi calendario? Quieres?"
        │ requests_link
awaiting_booking     the calendar link
        │ books
booked
```

**The pitch is unreachable until the lead names their own problem** — unless
they ask for it. `invites_pitch` ("como nos podrias ayudar?", "quisiera saber
que propones") jumps straight to the pitch from any stage. It is deliberately
separate from `asks_question`: collapsing the two would hand off at the warmest
point in the funnel. A lead asking what you do is opening the door; a lead
asking what it costs needs a human.

Everything else about the ordering is enforced as a test rather than a prompt
instruction.

Each step carries an autonomy level:

| Level | When | What happens |
|---|---|---|
| `auto` | qualifying questions, a link they just asked for | Agent sends it |
| `suggest` | the pitch | Panel proposes, owner clicks |
| `handoff` | objection, question, anything unclear | Human owns it |

A model improvising about pricing or scope in your name is worse than a reply
an hour later, so `objects` / `asks_question` / `unclear` always hand off from
every stage.

**Quick replies** (`quickReplies()`) are the ManyChat-style button row for the
inbox. They are templates, not generated text: at these stages the owner says
nearly the same thing every time, so a template is instant, free, and sounds
more like them than a model paraphrasing them would. The LLM is saved for where
personalization actually pays — the 300-character invite note.

The voice profile in `voice.ts` is extracted from real messages: one or two
lines, no opening `¿`, first name plus `!`, ends on a question, and a banned
list of the phrasings that give automation away.

## The orchestrator

`orchestrator.ts` sits between "a lead replied" and "something goes out":

```
lead replies
    │
    ▼
classifier  ──▶  intent + confidence + signals   (classifier.ts, LLM)
    │
    ▼
playbook    ──▶  next stage + how much autonomy that step deserves
    │
    ▼
orchestrator ─▶  send  |  suggest  |  handoff  |  nothing
```

The model classifies; it never writes the outgoing message. A misread reply
therefore produces a wrong *route*, which the confidence gate catches, instead
of a wrong *message* already sitting in someone's inbox.

Autonomy is the **lowest** of what the mode allows and what confidence earns:

| Mode | Ceiling |
|---|---|
| `copilot` | everything is proposed — where you start |
| `assisted` / `autopilot` | low-risk steps may send themselves |

- Confidence below `confidenceFloor` (0.75) → downgraded to suggest.
- Below `handoffFloor` (0.4) → a human reads it cold.
- The pitch is `suggest` in every mode. Objections, questions and unclear
  replies hand off in every mode.

Guards that hold regardless of mode: never two messages without a reply in
between, a cap on messages per conversation, opt-out wins over everything, and
out-of-hours sends are deferred to the next window rather than dropped.

Every downgrade is recorded in `notes`, so the panel can show why the agent did
or did not act.

## Safety rails

Quotas and jitter limit how fast the account acts. Neither notices when the
account is *already* in trouble, or when the same person is about to be
enrolled twice. Those are `health.ts` and `eligibility.ts`.

**The circuit breaker** watches invitation acceptance rate — the signal that
degrades first, and the one LinkedIn is known to weigh. An inbound account
should clear 60% comfortably, because everyone was asked to comment. Falling
toward cold-outreach numbers means something upstream is wrong (wrong audience,
wrong post, a keyword being gamed), and sending harder makes it worse.

| Condition | Verdict |
|---|---|
| Acceptance < 40% (min. 20 resolved) | `throttled` — invites stop, conversations continue |
| Acceptance < 60% | `warning` — keeps going, flagged |
| Action failures > 15% | `stopped` — a restriction is probably already live |
| Pending invites > 200 | `throttled` |

Throttling never punishes leads already mid-conversation for the account's
invite numbers.

**Cross-post deduplication** is the one that would bite hardest here. On an
account that posts often, the same people comment again and again — that is
what an engaged audience looks like. Treating each comment as a fresh lead
would mean a second invitation and a third opening DM to the same person.
`checkEligibility()` covers the whole account, not just one automation:
already-enrolled, already-invited, booked, disqualified, opted out, owned by a
human, or contacted inside the last 90 days.

Keyword matching is boundary-aware and accent-insensitive, so `GUÍA`, `guia!`
and `"guia"` all match while `seguían` does not.

## The LLM layer

Two calls, configured differently because they carry different risk.

**The classifier** reads each inbound reply and returns an intent, a confidence
and any facts the lead volunteered. It runs on structured outputs, so the shape
is valid by construction — but `parseClassification()` still runs on the result,
because clamping confidence and distrusting an unrecognized intent label are not
things a schema can express. It never writes the outgoing message: a misread
reply produces a wrong route, which the confidence gate catches, instead of a
wrong message already delivered. On an API error it returns `unclear` at zero
confidence, which the orchestrator already knows how to handle.

**The invite-note writer** produces the 300 characters that decide whether the
invite is accepted — and acceptance rate is both the funnel's first gate and the
signal the health breaker watches. Three guardrails:

- **The limit is enforced here, not requested from the model.** LinkedIn cuts at
  300 characters without asking, so a note that overruns is replaced by a plainer
  one that fits rather than arriving severed mid-sentence.
- **A failure never blocks the send.** An invite that never goes out because of a
  rate limit is a lead lost for a reason the lead will never learn. The template
  fallback is worse than a generated note and much better than silence.
- **The lead's comment is fenced as untrusted input.** It is text written by a
  stranger that lands inside a prompt; the instruction after the fence tells the
  model to read it as information about interest, never as instructions.

Both default to `claude-opus-5`, overridable per call site.

## The LinkedIn layer

`LinkedInAdapter` is an interface, not a class — the Playwright driver today, a
hosted API the day volume justifies it, a fake in tests. Nothing above it knows
which is running.

**Every selector lives in one file.** LinkedIn ships rotating obfuscated class
names, so selectors are the part of this codebase guaranteed to break;
isolating them makes a breakage a one-file fix by someone reading the live DOM.
Each is a list tried in order, so a redesign degrades to the next fallback
instead of failing outright.

**Failures are classified, because not all of them mean the same thing.** A
broken selector is our bug and says nothing about the account — counting it
against health would trip the breaker on a LinkedIn redesign. A refused action
is exactly what the breaker exists for. `AdapterError.kind` carries that
distinction.

The browser is a **persistent context**, so cookies and fingerprint survive
between runs and LinkedIn sees the same returning browser rather than a new one
each time the agent wakes. Point `CHROME_EXECUTABLE_PATH` at real Chrome and
the fingerprint stops being something to approximate.

## History import

The dedup rules ask "have we messaged this person before?" — and on a fresh
install the answer is always no. Without an import, the first campaign opens
with *"Buenas! Vi que me comentaste"* to people the owner has been talking to
for months. So importing existing conversations is a prerequisite, not a
nice-to-have.

Two constraints shape it:

- **Pace.** Reading two thousand conversations in ten minutes is the
  mass-retrieval pattern that gets accounts flagged. `planImportStep()` spreads
  it over days with a per-batch cap, and stops at an age cutoff.
- **Scope.** Metadata for everyone (who, when, who spoke last) — that is all
  dedup needs. Message bodies only for threads the playbook could still pick
  up: ones the lead spoke in last, recent enough to be live. These are third
  parties' messages and there is no reason to copy the whole inbox into
  Postgres.

## First run

```bash
npm install
npm test                                    # 96 tests
cp .env.example .env                        # fill in DATABASE_URL

npm run check-session -w @linkfy/agent
```

`check-session` opens the browser and verifies LinkedIn sees a live session.
On the first run the profile is empty — a window opens, you log in by hand, and
it persists from then on. **That login is the only manual step in the setup**,
and running this before anything that sends is worth the minute: a dead session
otherwise fails every job in the queue one at a time, each looking like a
separate problem.

Two branches carry most of the value:

**1st-degree goes straight to DM.** Existing connections cost nothing against
the invite cap. On an account with a real audience that is most of the volume,
and it is what keeps the cap from becoming the bottleneck.

**Everyone else is rationed and ranked.** LinkedIn allows ~100 invites per
rolling 7-day window; the defaults here sit at 80/week and 15/day, under the
limit on purpose. When a post produces more keyword comments than that,
`invite_queued` holds them and `priorityScore()` decides who gets the next slot.
Nobody is dropped — everyone still gets the public reply with what they asked
for.

## Rules that are in the code, not in a policy doc

- Only people who commented on your posts are ever stored. No profile crawling.
- Opt-out is checked before every send and wins over any pending step.
- A reply ends the automation. Two unanswered follow-ups end it too.
- Nothing is scheduled outside configured working hours.
- Every send is jittered; the DM after an accepted invite waits 2–6 hours.

## Setup

```bash
npm install
npx tsc --build
node --test packages/core/dist/engine.test.js

cp .env.example .env    # then fill in DATABASE_URL from Supabase
npm run db:push
```

## Status

Core engine and schema are done and green. Next up is `packages/agent` — the
Chrome driver, the comment scanner, and the LLM step that writes the invite note
against the person's headline and what they actually commented.

The LinkedIn adapter sits behind an interface on purpose, so the execution layer
can be swapped (a hosted API such as Unipile, say) without the engine or the
panel knowing about it.

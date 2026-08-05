# DoneFy

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
| `packages/core` | ✅ built, 16 tests | State machine, quotas, timing. Pure, no I/O |
| `packages/db` | ✅ schema | Drizzle schema for Postgres (Supabase) |
| `packages/agent` | ⏳ next | Chrome driver + LinkedIn adapter |
| `apps/web` | ⏳ after that | Next.js panel |

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
   └── they reply, at any point ──▶ replied   (automation stops, human takes over)
```

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

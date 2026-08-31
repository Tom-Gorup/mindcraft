# ROADMAP

Mission: replace mindcraft's shallow cognition layer with a drive-based, memory-rich,
multi-agent personality simulation. One phase ≈ one session. **Do not start a phase
without Tom's confirmation.** Branch per phase: `feat/phase-N-<name>`.

Conventions used below: every phase lists goal, files, acceptance criteria ("done when"),
and verification steps. Checkboxes are updated at the end of each session.

**Standing rule — UI parity.** The mindserver app at :8080 is the primary control
surface. Every phase that introduces new configuration (settings flags, profile keys,
tuning knobs) exposes it in the app in that same phase — via `settings_spec.json` and/or
the profile editor. End state: a user creates and fully configures a new agent in the
browser without ever touching JSON on disk. (Phase 1's `drives`/`cognition` profile
blocks predate this rule; their UI retrofit is a Phase 7 line item.)

**Standing rule — events, not log lines.** Every phase that introduces new behavior
emits typed events for it (Phase 2's event stream is the substrate), carrying the
taxonomy the research reports need: deliberate speech vs auto-narration vs commands
(bucketed by activity kind) vs deaths vs sessions vs goals/plans/reflections. If a
behavior only shows up in console logs, it doesn't exist to Phase 8.

---

## Phase 0 — Groundwork (Session 1)

- [x] Explore codebase; map event → agent → model → action flow
- [x] Write CLAUDE.md (repo map, pillars, conventions, working agreements)
- [x] Write ROADMAP.md (this file)
- [x] Tom reviews both files (approved 2026-08-30)

---

## Phase 1 — Cognitive core

**Goal:** an agent generates its own goals from personality-weighted drives, decomposes
them into a task tree, executes, and replans on failure — replacing the static
self-prompter string.

**Files:**
- Create `src/agent/cognition/` — `drives.js` (drive state: decay/satisfy over time, personality weights), `arbiter.js` (drive → goal selection), `planner.js` (goal → task tree via planning prompt; nodes map to commands/skills), `monitor.js` (execution observer; failure-triggered replanning), `index.js` (the loop: arbitrate → plan → execute → observe).
- Modify `src/agent/agent.js` (instantiate cognition loop; feed events), `src/agent/self_prompter.js` usage (cognition drives it or supersedes it behind a flag).
- Profile schema: optional `"drives"` block in profile JSON (weights + decay rates); defaults in `profiles/defaults/_default.json`.
- Settings flag: `use_cognition` (default off initially) — compatibility path so existing profiles boot unchanged.
- Tests: `test/cognition/` — drive decay, satisfaction, arbitration ordering, replan triggering (pure logic, no mineflayer).

**Done when:**
- [ ] An agent with no user commands generates a goal from drive state and pursues it *(implemented, needs live verification)*
- [ ] Inducing a failure (e.g. removing a needed item, blocking a path) visibly triggers replanning, not a retry loop *(implemented, needs live verification)*
- [ ] Drive weights in a profile JSON change observed behavior priorities *(profiles/wilbur.json ready for testing)*
- [ ] `use_cognition: false` reproduces today's behavior; existing profiles boot *(loop is fully dormant when flag off; needs boot check)*
- [x] Unit tests pass for drive decay/satisfaction/arbitration (26 tests, `npm test`)

**Verify:** unit tests; 15-min observation run on the LAN server with one agent, log of drive levels + chosen goals; induced-failure scenario transcript.

---

## Phase 2 — Memory

**Goal:** Generative-Agents-style memory — durable, retrievable, reflective — feeding
planning context instead of the lossy 500-char history summary.

**Files:**
- Create `src/agent/memory/` — `events.js` (append-only typed event stream: timestamp, type, content, importance score; the type taxonomy must cover what `tools/trace.py` distinguishes — speech vs narration vs command-by-kind vs death vs session — plus goal/plan lifecycle, so Phase 8 reports read straight from it), `index.js` (retrieval API: recency × relevance × importance; embeddings via the profile's embedding model, Ollama-friendly, word-overlap fallback), `reflection.js` (periodic job synthesizing events into belief entries), `store.js` (per-agent persistence in `bots/<name>/memory/`, JSON or SQLite).
- Modify `src/agent/memory_bank.js` call sites (places become spatial memories; keep `!rememberHere`/`!savedPlaces` working), `src/models/prompter.js` (planning/conversing context pulls retrieved memories, replacing/augmenting `$MEMORY`), `src/agent/history.js` (summarization chunk also emits events; history stays as short-term buffer).
- Tests: retrieval scoring (recency decay, importance weighting, relevance ranking with stubbed embeddings), reflection triggering.

**Done when:**
- [x] Events (chat, damage, deaths, goal outcomes, discoveries) are recorded with importance and persist across restarts (unit-verified round trip)
- [ ] An agent recalls a relevant event from a *prior session* and it demonstrably alters a plan (e.g. returns to a known resource location) *(implemented — retrieval feeds goal gen, planning, and conversing; needs live verification)*
- [x] Reflection produces belief entries from accumulated events (unit-tested with stubbed LLM)
- [ ] Runs fully local with Ollama embeddings *(Ollama embed endpoint fixed to /api/embed; needs check against homelab Ollama)*
- [x] Unit tests pass for retrieval scoring (18 new tests; 44 total)

**Verify:** unit tests; two-session experiment (session A: discover something; restart; session B: task whose plan should use it), memory files inspected in `bots/<name>/memory/`.

---

## Phase 3 — Skill library

**Goal:** Voyager-style compounding capability — successful generated code is stored,
retrieved by similarity, and composed, instead of regenerated.

**Files:**
- Create `src/agent/skills/` — `store/` (persisted skills: code + auto-generated docstring + embedding + usage stats), `library.js` (save on success, retrieve by task similarity, compose).
- Modify `src/agent/coder.js` (on successful execution: persist skill; before generation: retrieve candidate skills into `$CODE_DOCS` context or execute directly), `src/agent/library/skill_library.js` (unify retrieval so built-in docs and learned skills rank together), mindserver state (`full_state.js` + dashboard: skill count, recent usage).
- Tests: skill save/retrieve round-trip, similarity ranking with stubbed embeddings.

**Done when:**
- [ ] A task solved via `!newAction` on day 1 is solved on day 2 by retrieval, not regeneration (observable in logs: no coding prompt issued) *(implemented — "Coder: executing learned skill" log line; needs live verification)*
- [ ] Learned skills survive restart and appear in dashboard stats *(persistence unit-verified; stats exposed via full_state; dashboard panel renders in Phase 7)*
- [ ] A composed skill (calling a stored skill) executes successfully *(composition namespace smoke-verified under real SES; cycle/depth guards unit-tested; needs live verification)*
- [x] Retrieved skill code still runs inside the SES compartment with the same exposed surface — improved: found and fixed that SES lockdown had *never actually executed* (recursive guard bug); hardening is now real

**Verify:** unit tests; repeat-task experiment across a restart with prompt logs compared; skill store files inspected.

---

## Phase 4 — Concurrency (PIANO-style)

**Goal:** cadenced cognitive modules over a shared blackboard, with a single-writer
coherence gate so tiers never fight over the bot.

**Files:**
- Create `src/agent/cognition/blackboard.js` (shared agent_state: drives, active goal, plan, current action, recent percepts, social context), `src/agent/cognition/scheduler.js` (tiers + cadences: reflex = existing modes ~300ms, act, plan, reflect, social).
- Modify `src/agent/modes.js` (reads/writes blackboard, stays the reflex tier), `src/agent/action_manager.js` (formalize as the coherence gate: tier priority + interruption bookkeeping so plans resume/revise after reflexes), cognition loop from Phase 1 (split into plan/act tiers).
- Tests: blackboard consistency, interruption → resume/revise logic (mocked actions).

**Done when:**
- [x] A reflex (e.g. self_defense) interrupts a plan step without corrupting the task tree (unit-verified: task tree untouched, act tier stands down while reflex holds the slot)
- [x] After the interruption the plan resumes, or revises with the interruption recorded as an event (unit-verified: consume-once blackboard note in the next step prompt + `interruption` memory event; mid-step replan handoff tested)
- [x] Tiers run at their own cadences; slow planning never blocks reflexes (unit-verified: busy tiers are skipped not queued; error isolation per tier; smoke: 5 tiers, 0 errors over simulated run)
- [ ] No action-slot deadlocks or infinite interrupt loops in a 1-hour run *(needs live homelab soak)*

**Verify:** unit tests; scripted scenario (spawn a mob mid-task) showing interrupt + clean resume in logs; 1-hour soak run.

---

## Phase 5 — Social layer

**Goal:** relationships, gossip, and trade that emerge from drives and personality,
not scripts.

**Files:**
- Create `src/agent/social/` — `relationships.js` (per-pair trust/affinity/grudge, updated from interaction events, persisted), `gossip.js` (relaying memories secondhand with attribution, feeding the hearer's memory stream), `trade.js` (simple negotiation over conversation + `giveToPlayer`).
- Modify `src/agent/conversation.js` (interaction events → relationship updates; relationship state → conversation context), cognition social tier (Phase 4), profile schema (personality modulates trust gain/loss, generosity, gossip propensity).
- Tests: relationship update rules, gossip attribution/decay.

**Done when:**
- [ ] Relationship scores change from interactions (help, gift, attack, insult) and persist
- [ ] Two agents with conflicting drives produce an unscripted dispute (observable transcript)
- [ ] A third agent hears about the dispute via gossip, with attribution, and its relationship scores shift accordingly
- [ ] A trade completes via negotiation between two agents

**Verify:** unit tests; 3-agent run designed with conflicting drive profiles; transcripts + relationship store diffs.

---

## Phase 6 — Model routing + economics

**Goal:** run 24/7 affordably — right model for each call site, event-driven prompting,
costs visible.

**Files:**
- Create `src/models/router.js` (tier registry: reflex/chatter → local Ollama, planning → mid API, reflection/pivotal → frontier; per-call-site tier tags; fallback on provider failure), `src/models/metering.js` (per-agent token/cost counters). <!-- gitleaks:allow -->
- Modify `src/models/prompter.js` (all prompt entry points declare a tier), cognition loop (event-driven prompting: state change, damage, chat, goal completion — replacing fixed idle cadence), profile schema (`"tiers"` block mapping tier → model spec), mindserver + dashboard (cost/token panel).
- Tests: routing table resolution, metering arithmetic.

**Done when:**
- [ ] Every LLM call goes through the router with a tier tag; logs show call site + tier + tokens
- [ ] A 1-hour 3-agent run shows >70% of calls on the local tier
- [ ] Per-agent cost surfaced in the dashboard and in a run-summary log
- [ ] Prompting is event-driven; the 2s idle poll is gone (or demoted to a low-frequency heartbeat)

**Verify:** unit tests; instrumented 1-hour 3-agent run with tier-distribution and cost report.

---

## Phase 7 — Observability + full in-app configurability

**Goal:** the whole sim understandable at a glance on a TV, and fully steerable from
the browser — create, configure, and tune agents without touching JSON on disk.

**Files:**
- Modify `src/mindcraft/public/index.html` (or split into modules): per-agent panel (drive bars, current goal, plan step, last inner thought), relationship graph, global event feed. Data via existing `get-full-state` poll + new socket events.
- Profile editor in the app: model roles (chat/code/vision/embedding), prompt templates, modes, `drives` weights/decay, `cognition` tuning, few-shot examples — backed by a profile schema spec (sibling of `settings_spec.json`) so future keys get UI for free. Retrofits Phase 1's config per the UI-parity rule.
- Modify `src/agent/library/full_state.js` (expose cognition/social state), `src/mindcraft/mindserver.js` (profile CRUD + new events as needed).
- Optional: director mode — spectator viewpoint cycling to the highest-activity agent.

**Done when:**
- [ ] Dashboard shows, live per agent: drive levels, active goal, plan step, last thought
- [ ] Relationship graph renders and updates from the social store
- [ ] Event feed streams notable events (goal changes, disputes, reflections, deaths)
- [ ] A new agent can be created and *fully* configured in the browser — personality, models, modes, drives — and edits to a live agent apply on restart
- [ ] Tom can pull it up on a TV and follow the sim without reading logs

**Verify:** manual review during a 3-agent run; create + configure a fresh agent end-to-end in the app; screenshot set attached to the session note.

---

## Phase 8 — Research lab: reporting, runs, and multi-world

**Goal:** turn the starter behavioral trace (`tools/trace.py`, imported 2026-08-30) into
a first-class research facility inside the app: live and historical reports, selectable
scopes, named comparable runs, and multiple Minecraft worlds under one mindserver.

**Files:**
- `tools/trace.py` — the reference implementation: event taxonomy (speech / narration / command-by-kind / death / session), timeline with session bands + hostile-pressure ridge, per-agent cards, interaction ledger, who-addressed-whom matrix, resource flow, memory self-account vs observed behavior, filterable event log. Keep working as the offline path.
- New report module in `src/mindcraft/` + report pages in the web app, sourced from Phase 2 agent event streams (not log scraping) aggregated by the mindserver.
- Run model in the mindserver: named runs with start/stop, per-run event archive, JSONL export.
- World model: agents already carry per-agent `host`/`port` — add world grouping/labels in the registry, dashboard, and reports so several worlds run concurrently under one mindserver.
- Modify `src/agent/` event emission where gaps exist (goal lifecycle, plan revisions, reflections, gossip — as those phases land).

**Done when:**
- [ ] Reports render live in the app with the full trace.py feature set, scoped by agent selection, time window, world, and run
- [ ] The "believed vs observed" view pairs each agent's memory/beliefs with its actual event history
- [ ] Two worlds with agents in each run concurrently under one mindserver; dashboard and reports group and filter by world
- [ ] Runs are first-class: named, started/stopped, archived, exportable as JSONL, and comparable side by side
- [ ] In-app report agrees with `tools/trace.py` output on the same window (parity check)

**Verify:** 2 worlds × 2 agents concurrent run; produce per-world in-app reports; export a run and diff key counts against the offline trace.

---

## Later / parking lot

- Director camera with commentary
- 10+ agent scaling pass (config, not refactor — validate the assumption)
- Long-horizon settlements: shared building projects, economy
- Voice (TTS already supported) tied to personality
- Cross-run experiments: same personalities, different worlds/seeds; statistical comparison of outcomes

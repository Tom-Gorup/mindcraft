# SESSIONS

Newest entry last. Each entry: what changed, what's next, known issues.

---

## Session 1 — 2026-08-30 — Phase 0: Groundwork

**What changed:**
- Explored the full codebase; mapped the event → agent → model → action loop (documented in CLAUDE.md).
- Created `CLAUDE.md` (repo map, current-loop explanation, conventions, design pillars, working agreements).
- Created `ROADMAP.md` (Phases 1–7 with files, acceptance criteria, verification).
- Tom reviewed and approved both. No code changes.

**What's next:**
- Phase 1 (cognitive core) on branch `feat/phase-1-cognition`: new `src/agent/cognition/`
  (drives, arbiter, planner, monitor, loop), `"drives"` block in profile schema,
  `use_cognition` settings flag for compatibility, unit tests under `test/cognition/`.
- Decision to make at Phase 1 start: test runner (proposal: built-in `node:test`, zero deps).

**Known issues / watch-outs discovered during exploration:**
- `Ollama.embed()` posts `{model, input}` to the legacy `/api/embeddings` endpoint, which
  expects `prompt` (`/api/embed` takes `input`). May silently degrade retrieval to
  word-overlap. Verify against the homelab Ollama early in Phase 2.
- Load-bearing quirks — match, don't fix: `prompter.skill_libary` typo, `NPCContoller`
  class name, in-body `/** ... **/` docstrings extracted via `toString()`, cwd-relative
  paths (run from repo root).
- Several `world.js` functions lack docstrings and are invisible/"nonexistent" to
  generated code.
- `max_tokens` legacy handling in `prompter.js` is dead code.
- No test framework exists in the repo yet.
- Docs not yet committed to git (no branch created; awaiting Phase 1 branch or Tom's
  preference for committing docs to `develop`).

---

## Session 2 — 2026-08-30 — Phase 1: Cognitive core (implementation)

**What changed** (branch `feat/phase-1-cognition`, commits `f2c505a`..`ed981f4`):
- New `src/agent/cognition/`: `drives.js` (pure drive state — weights, decay, satisfy,
  urgency = weight × (1 − level)), `arbiter.js` (selection with hysteresis + contentment
  null), `monitor.js` (retry → replan → abandon budgets, step timeouts), `planner.js`
  (LLM goal/plan generation + defensive JSON parsing), `sensors.js` (health/hostiles/
  hunger/inventory-value → sensor levels), `index.js` (`CognitionLoop`, ticked from
  `agent.update()`, busy-guarded, persists to `bots/<name>/cognition.json`).
- Integration: `use_cognition` flag (settings.js + settings_spec.json, default false);
  `!stepDone`/`!stepFailed` commands (auto-blacklisted when flag off); `!endGoal` also
  abandons autonomous goals; `goal_generation`/`task_planning` templates in
  `_default.json` + prompter methods; `$SELF_PROMPT` now surfaces the autonomous goal;
  `full_state.js` exposes drive/goal/step for the dashboard; death and player-interaction
  hooks in agent.js. Steps execute through the existing handleMessage/command loop —
  self_prompter untouched, user `!goal` outranks cognition, conversations pause it,
  benchmark tasks disable it.
- `profiles/wilbur.json` — example explorer personality (drive overrides + loop tuning).
- Tests: `test/cognition/` (26 tests, node:test), `npm test` script added.

**Verification status:** unit tests pass (26/26); all touched files pass syntax check;
new files lint clean and modified files introduce no new lint errors (repo baseline has
pre-existing ones). **Live acceptance runs not yet done** — this checkout has no
node_modules and no reachable Minecraft server. Remaining Phase 1 acceptance: observe
autonomous goal pursuit, induced-failure replanning, `use_cognition:false` boot parity.

**What's next:**
- `npm install` on the homelab (npm cache needs `sudo chown -R 501:20 ~/.npm` first),
  point settings.js at the LAN server, run one agent with `use_cognition: true` +
  wilbur.json; watch `Cognition:` log lines and the dashboard action cell.
- Induce a failure mid-plan (e.g. `/clear` a needed item) to verify replan; then check
  the remaining Phase 1 boxes and start Phase 2 (memory) after Tom's go-ahead.

**Known issues:**
- Cognition step prompts still poll on idle (~2s cadence like self_prompter);
  event-driven prompting is deliberately deferred to Phase 6.
- Goal/plan quality depends on the chat model honoring JSON codeblocks; parse failures
  are logged and retried on the next arbitration tick (15s cooldown), never crash.
- A goal suspended by a user `!goal` resumes when self-prompting stops — intended, but
  watch for surprises.
- gitleaks pre-commit hook false-positived on ROADMAP.md wording; line carries an
  inline `gitleaks:allow` marker.

### Session 2 addendum — plan expansion (Tom)

Tom added two directives, folded into the plan:
- **UI parity (standing rule):** everything configurable must be configurable in the
  :8080 app, including creating and fully configuring new agents in the browser.
  Applies to every phase from now on; Phase 1's `drives`/`cognition` blocks get their
  UI retrofit as a Phase 7 line item (profile editor backed by a profile schema spec).
- **Phase 8 (new): Research lab.** Level up Tom's offline behavioral trace
  (`~/Documents/mindcraft-analysis/trace.py`, imported to `tools/trace.py`) into
  in-app live/historical reports: scoped by agent/time/world/run, named comparable
  runs with JSONL export, multiple concurrent worlds under one mindserver, and a
  believed-vs-observed view (memory self-account vs event history). Second standing
  rule added: new behaviors emit typed events (Phase 2 stream), never just log lines —
  Phase 2's event taxonomy is now explicitly required to cover trace.py's categories
  plus goal/plan lifecycle. report.html (7.6MB generated artifact) was not committed.

---

## Session 3 — 2026-08-30 — Phase 2: Memory (implementation)

**What changed** (branch `feat/phase-2-memory`, commit `9eada60`):
- New `src/agent/memory/`: typed append-only event stream (taxonomy = trace.py
  categories + goal lifecycle + beliefs), JSONL persistence per agent
  (`bots/<name>/memory/`), retrieval scored recency × relevance(×2) × importance
  (embeddings when available, word-overlap degradation otherwise — mirrors the
  examples/skill-library contract), background reflection that synthesizes belief
  events once accumulated importance crosses a threshold (default 8).
- Event emission wired: chat received/speech/commands/damage/death/session/narration
  in agent.js; goal started/completed/abandoned/replanned in cognition; successful
  generated code in coder.js.
- `memory_bank` places are now durable (previously lost every restart): mirrored as
  `place` events and hydrated on boot. `!rememberHere`/`!savedPlaces` unchanged.
- Retrieval feeds prompts: `$MEMORY` (conversing) is augmented with memories relevant
  to the last message; `$RELEVANT_MEMORIES` added to goal_generation/task_planning;
  new `reflecting` template + `promptReflection`.
- **Fixed Ollama embed**: was POSTing `input` to legacy `/api/embeddings` (which
  expects `prompt`) and reading a field that endpoint doesn't return — embeddings
  silently never worked locally. Now uses `/api/embed`. This also benefits the
  skill library and examples retrieval.
- `use_memory` flag (settings.js + settings_spec.json, default false), memory status
  in full_state for the dashboard. Deps installed in this checkout
  (`--ignore-scripts` + canvas rebuild; only `gl` unbuilt → vision camera can't
  load on this Mac — homelab unaffected).

**Verification:** 44/44 unit tests (18 new: scoring math, taxonomy, store round-trip
+ corruption tolerance, retrieval ranking incl. embedding-failure fallback, reflection
trigger + accumulator resume, disabled no-op). Constructor smoke test with both flags
on passes (record → retrieve → tick → command dispatch). Module import chain verified
against real node_modules. No new lint errors vs baseline. **Live acceptance still
pending** (needs LAN server + Ollama): prior-session recall altering a plan, and
Ollama embedding end-to-end.

**What's next:**
- Live verify Phases 1+2 together on the homelab: run with `use_cognition` +
  `use_memory` true, restart between sessions, confirm recall alters planning; check
  `bots/<name>/memory/events.jsonl` contents and dashboard status.
- Phase 3 (skill library) after go-ahead — coder.js already emits `code` events;
  Phase 3 turns those into a retrievable, composable store.

**Known issues:**
- Retrieval weight for relevance is doubled after a test exposed high-importance
  events (deaths) outranking directly relevant memories on unrelated queries.
- Reflection uses the chat model (frontier routing comes in Phase 6); threshold 8
  ≈ one reflection per ~16-20 meaningful events.
- History summarization does not emit its own event (individual messages are already
  events; a summary event would double-count) — deliberate deviation from the
  original roadmap wording.
- Memory tuning (`memory` profile block) awaits the Phase 7 profile editor for UI
  parity, same as `drives`/`cognition`.

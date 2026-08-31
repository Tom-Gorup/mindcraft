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

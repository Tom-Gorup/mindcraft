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

---

## Session 4 — 2026-08-30 — Hardening review of Phases 1-2 (pre-Phase-3 gate)

Tom requested a bug/logic review before Phase 3. Ran two independent adversarial
reviewers (state-machine/concurrency lens; integration-contract lens) plus a manual
pass. ~30 findings; all blockers and majors fixed in commit `15bfb2a`, 48/48 tests.

**Highlights of what was broken and is now fixed:**
- `$DRIVE` replacement clobbered `$DRIVE_STATE` — every autonomous goal was being
  generated blind to drive levels and recent outcomes.
- No interrupt path + unbounded command loop for cognition step prompts; now bounded
  (5 responses/prompt) with a step_interrupt flag in checkInterrupt.
- The agent's 300ms update pump had no exception guard — a disk error in
  memory.record could silently kill modes/self-prompting/cognition. Pump and
  record() are now exception-proof (vllm profiles could also crash the process
  via a missing embed method — stub added).
- satisfy() on sensor drives was erased next tick → infinite wealth-goal
  regeneration; success now sets a cooldown. `!endGoal` recorded success as failure.
- Mid-goal preemption added (safety can interrupt a wealth goal via arbiter
  hysteresis — switch_margin was dead code before).
- Prompt injection: retrieved chat memories were substituted before placeholder
  expansion ($STATS in chat would expand; $' patterns duplicated prompt tails).
  All dynamic content now substituted after replaceStrings with function replacers.
- Reflection storms on LLM failure; permanent embedding-outage latch with no
  backfill; step timeouts burning budget during conversations/long actions;
  modes double-prompting concurrently with cognition — all fixed.
- Agents now spawn curious (initial_level 0.5) instead of drive-inert for ~30 min.

**Deliberately deferred (documented, not forgotten):**
- events.jsonl grows unbounded on disk — accepted; it is Phase 8's research corpus.
  RAM is capped (5000 events) with embedding-map pruning.
- Mixed-scale relevance (cosine vs word-overlap for never-embedded event types) —
  mitigated by the relevance floor; a principled fix can ride with Phase 3 retrieval
  unification.
- Dashboard panels for cognition/memory state (full_state already exposes both) —
  Phase 7 by plan.

**Next:** Phase 3 (skill library) on Tom's go-ahead. Live verification of 1+2 on the
homelab still pending (unchanged).

---

## Session 5 — 2026-08-30 — Phase 3: Skill library (implementation)

**What changed** (branch `feat/phase-3-skills`, commit `5b807b7`):
- New `src/agent/skills/`: `SkillStore` (per-agent JSON, corruption-tolerant) and
  `LearnedSkills` — on every successful `!newAction`, the code is saved with an
  LLM-generated docstring (fallback: task text) and an embedding; near-duplicate
  tasks refresh the existing skill instead of duplicating. Retrieval: embedding
  cosine (task-vs-task overlap fallback). Direct execution when similarity ≥ 0.92
  cosine / 0.6 overlap and the skill's failures ≤ successes; falls back to normal
  codegen on failure, recording the failure.
- Composition: generated code sees `learned.<name>(bot)` via a lazy Proxy endowment
  (skills learned mid-session immediately callable); learned code compiles through
  the identical sanitize/interrupt/template/compartment pipeline; cycle and depth
  (3) guards; per-call success/failure stats. Lint validates `learned.*` names.
- Unified retrieval: learned docs rank in the same `$CODE_DOCS` pool as built-in
  library docs. Fixed a pre-existing bug where the word-overlap fallback compared
  the query against embedding *vectors* (crash on partial init, empty docs
  otherwise).
- **SECURITY FIND: SES lockdown never actually ran.** `lockdown.js`'s wrapper
  function called `lockdown({...})` which resolved to *itself*, hit the guard,
  and returned — the "sandbox" was compartment namespace isolation only, with
  mutable shared intrinsics, for the repo's entire history. Now calls
  `globalThis.lockdown` (overrideTaming: severe, try/catch with loud failure).
  Verified under real hardening: compartment eval, Proxy endowment, execTemplate,
  minecraft-data loaded before AND after lockdown. **Top live-run watch item:**
  the full mineflayer protocol stack has never run hardened — if a lib mutates
  intrinsics lazily, expect throws at first `!newAction`; report, don't panic.
- `use_skill_library` flag (settings + spec, default off), skill stats in
  full_state, `skill_docstring` template + prompter method.
- 13 new unit tests (61 total, all passing); composition + lockdown smoke tests.

**Next:** Live verification of Phases 1-3 together on the homelab (flags:
use_cognition, use_memory, use_skill_library + allow_insecure_coding). Watch for:
"Coder: executing learned skill" on repeat tasks, skills.json growth, and any SES
taming errors. Then Phase 4 (concurrency/blackboard) on Tom's go-ahead.

**Known issues / notes:**
- Skill store is per-agent by design (mission: "each agent has a growing skill
  library"); ROADMAP's original `src/agent/skills/store/` path was reinterpreted —
  that's module code; runtime data lives in `bots/<name>/skills/`.
- Direct-execution cosine threshold (0.92) is embedding-model-dependent; tune per
  model on the homelab (profile `skills.direct_execute_cosine`).
- `skills` profile block awaits the Phase 7 profile editor (same as drives/
  cognition/memory).

---

## Session 6 — 2026-08-30 — Phase 4: Concurrency (implementation)

**What changed** (branch `feat/phase-4-concurrency`, commit `c5af955`):
- `blackboard.js` — the shared agent-state surface: percepts, drive urgencies,
  goal/step, pending replans, current action, consume-once interruption notes,
  social context, per-tier telemetry. Exposed via full_state for Phase 7.
- `scheduler.js` — cadenced tier dispatch from the existing 300ms pump. Tiers are
  skipped (never queued) while their previous run is in flight; sync tiers complete
  in-tick; per-tier error isolation (a throwing tier can't hurt siblings or the pump).
- CognitionLoop split: `planTick` (~1s: drives, arbitration, goal gen, replanning,
  preemption, timeouts) and `actTick` (~300ms: step prompting), separate busy guards.
  Big win: preemption/timeout evaluation now continues WHILE a step's LLM call is in
  flight; replans break the act loop via step_interrupt before revising the plan.
- Five tiers registered in agent.startEvents: reflex (modes, always first), act,
  plan, reflect (memory reflection triggering moved out of record() into the tier),
  social (placeholder that keeps conversation state on the blackboard until Phase 5).
- Coherence gate: `action_manager.isReflexActive()`; the act tier waits out reflexes
  instead of stealing the slot back (no churn loops). modes.js reports interruptions
  of `action:*` labels → blackboard + `interruption` memory event → the next step
  prompt opens with a re-assess note. Task tree is never touched by interruptions.
- 15 new unit tests (76 total): cadence math, busy-skip semantics, error isolation,
  interruption→resume with intact plan, mid-step replan handoff, timeout accrual
  while act-busy, blackboard mirroring.

**Verification:** 76/76 tests; 5-tier smoke over 50 simulated ticks — zero tier
errors, correct cadence ratios, graceful handling of unparseable LLM stubs. No new
lint errors. **Pending live:** the 1-hour no-deadlock soak (needs homelab).

**Next:** Phase 5 (social layer) on Tom's go-ahead — the social tier slot, blackboard
social context, and conversation.js hooks are ready for it. Live verification of
Phases 1-4 on the homelab remains the standing ask.

---

## Session 7 — 2026-08-30 — Hardening review of Phases 3-4 (pre-Phase-5 gate)

Tom requested a bug/logic review of the last two phases. Two adversarial reviewers
(skills/coder lens; tier-concurrency lens) + manual pass. ~30 findings; all blockers
and majors fixed in `0b8a426`, 81/81 tests (7 new regressions).

**The three blockers:**
- **Skill composition was dead on arrival**: lintTemplate.js never declared `learned`,
  so ESLint's no-undef rejected every composing program — 5 wasted codegen round-trips
  per attempt, and the entire Proxy/cycle-guard machinery was unreachable from codegen.
  Fixed + verified against the real lint pipeline; coding prompt now teaches `learned`.
- **Interrupted programs were learned as successful skills**: the injected interrupt
  checks make truncated code return normally, so a program stopped two statements in
  by a reflex became a trusted skill with an empty-output docstring. Save now gated on
  !interrupt_code everywhere.
- **step_interrupt permanent latch**: abandoning a goal armed the interrupt flag with
  no act loop left to clear it — every subsequent system prompt (death messages, mode
  reprompts, user !goal self-prompting) silently returned without calling the model,
  in the worst case as a permanent deadlock. Flag now raised only when an act loop is
  in flight and cleared before any guard.

**Notable majors:** save/query embedding asymmetry (task+docstring vs task) that would
have kept the 0.92 direct-execution threshold from ever firing with real embedding
models; cosine and word-overlap scores compared in the same max(); digit-blind overlap
('mine 5 diamonds' ≡ 'mine 50 diamonds' at score 1.0); self-referential skill refresh
that permanently bricked composed skills; a doc/score desync race throwing TypeErrors
into the prompt path; non-atomic full-file skills.json writes on every stat update
(crash = library wiped, event-loop stalls at scale); task-context regex silently
falling back to an older unrelated task; reflex interruptions misattributed to the
plan when a user-conversation action was interrupted. lockdown() now runs at agent
boot (deterministic failure) instead of lazily at the first !newAction.

**Honest posture correction (from review):** with `evalTaming: 'unsafeEval'` and host
functions endowed into the compartment, generated code can still reach the primal
realm via constructor chains (e.g. `skills.log.constructor('return globalThis')()`).
The SES fix restores intended intrinsic-freezing, but the compartment is a namespace
boundary, not a security boundary — `allow_insecure_coding` remains exactly as
dangerous as its name says. Container isolation (docker) is the real boundary.

**Deferred (documented):** learned Proxy identity quirks (fresh closure per access,
no toString); compiled-compartment cache never evicted; max_skills is a hard stop
with no LRU; message embedded twice per !newAction (built-ins + learned pools);
scheduler tier telemetry reflects dispatch only (cognition_busy on the blackboard
carries the real in-flight state).

**Next:** Phase 5 on Tom's go-ahead. Live verification of Phases 1-4 (all flags on)
remains the standing homelab ask.

---

## Session 8 — 2026-08-31 — Holistic review of Phases 1-4 (security + integration + economics)

Tom asked for a whole-system pass before the final phases. Three reviewers with
cross-cutting lenses (adversarial security; cross-subsystem interactions with all
flags on; end-to-end flow + resource economics) plus a manual pass. This found
substantially more than the per-phase gates did, because the earlier gates reviewed
subsystems in isolation. All blockers, criticals, and highs fixed in `0bdab8d`;
86/86 tests (5 new); full four-subsystem integration smoke verified.

**One critical, pre-existing, upstream:** `speak.js` built a shell command string
from LLM chat text and ran it through `exec()`. Only quotes were escaped, so `$(...)`
and backticks survived: a player who convinced the model to echo a payload got host
RCE — no sandbox, no `allow_insecure_coding` required. Only gated by `settings.speak`
(default off, but toggleable from the dashboard). Now `spawn()` with argv arrays.

**One HIGH chain, ours + upstream:** the dashboard rendered bot chat and agent names
into `innerHTML` unescaped, and re-rendered the cached last message on every status
change → stored XSS from Minecraft chat → the page holds an unauthenticated socket.io
connection → `create-agent` with `allow_insecure_coding: true` → host RCE. Fixed at
two points: `escapeHtml()` everywhere in the dashboard, and an Origin check on the
socket.io handshake (also closes DNS-rebinding).

**Other security fixes:** `profile.name` reached `mkdir`/`writeFile` *before*
validation (path traversal; and no validation at all in the mindserver path);
player-seeded `!newAction` text became a permanent learned-skill docstring shown to
the coding model, with the fallback path preserving newlines so chat could forge
extra `$CODE_DOCS` entries; `skills.json` (executable, direct-executed without lint)
had two-field validation; SES lockdown failure was swallowed and code ran anyway
(now fails closed); `profile.skin` injected Minecraft commands via `bot.chat`'s
newline splitting; `set-agent-settings` bypassed the settings-spec filter.

**Cross-subsystem blockers (only visible with all flags on):**
- Reflexes couldn't interrupt the cognition act loop — only the legacy self-prompter
  had that wiring — so the loop's next command re-stopped the reflex. A bot could
  keep executing its plan while burning or drowning.
- `step_interrupt` was global, so a death message or mode reprompt running
  concurrently with the act loop was silently swallowed. Now scoped to the act
  tier's own `handleMessage`.
- `promptCoding`'s `awaiting_coding` flag had no `try/finally`: a single provider
  error latched it forever, after which every `!newAction` returned a stub that was
  compiled, "succeeded", and **persisted as a no-op learned skill** — permanent,
  silent, self-reinforcing corruption of a durable store.
- Concurrent `handleMessage` loops interleaved into one shared history, corrupting
  both transcripts. User messages now interrupt the autonomous loop.

**Durability:** history writes were O(n²) read-modify-write (~39GB/day and an
eventually pump-blocking parse) → JSONL; concurrent evictions silently lost a
summary chunk → serialized queue; `embeddings.jsonl` grew unbounded and was fully
parsed at boot → compacted on load; `cleanKill` now flushes queued history,
cognition, and throttled skill stats; `cognition.json` no longer loads when the flag
is off; benchmark runs no longer see `!stepDone`/`!stepFailed`.

**Economics (measured, NOT yet fixed — this is Phase 6's brief):** one agent at
steady state = ~1,160 chat calls, ~2,460 embed calls, ~3.45M input tokens/hour,
running at ~96% of its own cooldown ceiling. ≈$27/day/agent on a cheap API tier;
~half a 3090 on prefill alone, so 4 agents oversubscribe the box ~2×. Diagnosed
hotspots are itemized in ROADMAP Phase 6. Two cheap wins landed now (query-embedding
LRU; `!nearbyBlocks` scanning 200 blocks instead of 10,000 per prompt); the big one
(`$COMMAND_DOCS` prompt reordering for prefix caching, ~45% token cut) is a
behavioral change and belongs in Phase 6 with live validation.

**Accepted risks, now documented in CLAUDE.md:** the compartment is a namespace
boundary not a security boundary; any player can invoke any non-blocked command;
the mindserver is unauthenticated to local processes; a custom provider `url`
exfiltrates the API key.

**Next:** Phase 5 (social layer) on Tom's go-ahead. The standing homelab ask is
unchanged and now higher-value than ever: one run with all flags on validates four
phases at once.

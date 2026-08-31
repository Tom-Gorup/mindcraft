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

---

## Session 9 — 2026-08-31 — Phase 5: Social layer (implementation)

**What changed** (branch `feat/phase-5-social`, commit `d395278`):
- New `src/agent/social/`. Three pure, unit-tested modules — `relationships.js`
  (trust/affinity/grudge per peer, personality-scaled interaction deltas where harm
  outweighs help, decay toward baseline with forgiveness pacing grudge fade),
  `gossip.js` (retellable-memory selection, trust-weighted credibility capped below
  firsthand, attributed notes), `trade.js` (offer bookkeeping, value ratio, an
  acceptance threshold widened by friendship and generosity, expiry) — plus
  `index.js` (`SocialModule`) binding them to the agent with an atomic, throttled
  store in `bots/<name>/social/`.
- **Key design decision, informed by the Session 8 audit:** social is *not* a
  deliberative driver. It has no prompt loop, never seizes the action slot, and adds
  **zero LLM calls** — relationship math is pure and gossip is chosen from memories
  the agent already holds. It reaches behavior purely by modulating the conversation
  prompt via a new `$SOCIAL` slot (substituted late, function replacer, since it
  contains peer names and remembered chat).
- Hooks: chat (`conversed`), `!givePlayer` (`gave_item`), `!attackPlayer`, killer
  parsed from the death message (`killed_by`), inbound bot messages about third
  parties absorbed as attributed gossip. Trade commands `!offerTrade` /
  `!acceptTrade` / `!declineTrade`, all blocked when the flag is off. Relationships
  surface in `full_state` and on the blackboard for Phase 7.
- `profiles/greta.json` — a hoarder (wealth 0.95, generosity 0.15, forgiveness 0.4,
  high gossip) built to collide with Wilbur the explorer; Wilbur gained a matching
  `social` block. This is the pair for the dispute scenario.
- 29 new tests (115 total), including two-agent gossip propagation and a full trade
  cycle. Verified: hearsay provably moves a relationship less than firsthand
  experience, and less again when the teller is distrusted.

**Verification:** 115/115 unit + integration tests; end-to-end smoke with the real
Greta profile shows firsthand harm plus attributed gossip producing a resentful
disposition, correctly rendered into `$SOCIAL` and onto the dashboard payload, zero
tier errors. New module lints clean; `conversation.js` went 5 → 4 pre-existing errors.

**Acceptance:** 3 of 4 criteria met in test. The fourth — two agents with conflicting
drives producing an *unscripted* dispute — is inherently a live-run observation and
is what wilbur.json + greta.json exist for.

**Next:** Phase 6 (model routing + economics) on Tom's go-ahead — and it now has a
measured brief from Session 8 (~3.45M input tokens/hour/agent, with the top hotspots
itemized in ROADMAP). Standing homelab ask now covers five phases in one run.

**Known issues / notes:**
- Gossip absorption uses keyword matching (`stole`, `helped`, ...) to classify a
  mention as positive/negative. Deliberately cheap — an LLM classifier here would
  add a model call per inbound bot message, which the economics audit rules out.
  Expect occasional misreads; revisit if Phase 6 frees budget.
- Trade item values are a small hardcoded table; unknown items default to 1. Fine for
  fairness *advice*, not a real economy.
- `social` profile block awaits the Phase 7 profile editor, like the other blocks.

---

## Session 10 — 2026-08-31 — Phase 5 validation gate

Tom asked for a bug/logic check on Phase 5 before Phase 6. Two adversarial reviewers
(social-module logic; cross-system effects with all flags on) plus manual probing.
All blockers and majors fixed in `ea1ca6b`; 129/129 tests (14 new regressions).

**The trade feature was fundamentally broken and would not have worked live:**
- `receiveTrade()` had **no production caller** — an offer was only a sentence, so
  `!acceptTrade` always answered "No pending trade offer." Offers now travel in a
  canonical wire format parsed back into the peer's book.
- `TradeBook` kept incoming and outgoing offers in one map keyed by peer, so an
  agent's own offer answered `pending()`. The prompt described it inverted ("they
  give 1 diamond for your 4 bread" to the bot *giving* the diamond), and
  `!acceptTrade` on your own offer **handed over the goods you meant to receive**
  while crediting the counterparty with trust.
- `traded_fairly` was awarded on your own payment, so a peer could farm trust by
  offering and never delivering — the exact inverse of the intended dynamic. Trust
  is now earned only on confirmed delivery, and `trade_reneged` (previously dead
  code) costs the defector.

**Social dynamics were subtly wrong in ways that would have compounded:**
- Gossip could be relayed straight back to its source (the filter checked
  `data.source`, but gossip events store `data.teller`), and the agent's own
  trust/grudge *numbers* were gossip-eligible — two bots would have laundered
  hearsay into fresh "evidence" every round trip. Fixed with a shareable-type
  allowlist plus a teller filter.
- Hearsay manufactured grudges. New `heard_ill_of`/`heard_well_of` move opinion but
  never resentment — resentment should require something happening to you.
- `!attackPlayer` recorded the *victim's* event on the aggressor. Separately, there
  was no victim-side hook at all, so a bot beaten but not killed felt nothing and
  every firsthand signal in the system was negative. Added `entityHurt` →
  `attacked_by` and `playerCollect` → `received_item`.
- Gossip keywords fired on "killed"/"attacked", which in Minecraft almost always
  refer to mobs ("Greta killed the zombie for me") — constant false grudges. Now
  interpersonal verbs only, mob context excluded, claims scoped to the sentence.

**Also fixed:** `!offerTrade` hijacked live conversations (orphaning the previous
partner with no liveness monitor); a 90s delivery timeout punished honest-but-slow
partners as defectors (now 6 min); `$SOCIAL` was missing from all four profiles that
override `conversing`, making the feature inert-but-paid-for there; `$SOCIAL` used
the stale bot-only `last_sender`; a corrupt `relationships.json` produced NaN
dispositions and silently killed social context for the session; chat spam could
farm trust; relationship eviction only ran on load; and trade commands were offered
during benchmark tasks.

**Deferred (documented):** human-to-bot trades can't complete (no way for a human to
register acceptance — the offer simply expires); `_absorbGossip` only considers bot
subjects while outbound gossip can name humans; the blackboard ships the relationship
array twice per dashboard poll. None are correctness risks.

**Next:** Phase 6 (model routing + economics), with the Session 8 measurements as its
brief. Note Phase 5 adds ~10-16% to prompt tokens (trade command docs ride every
prompt; `$SOCIAL` adds ~271 typical tokens), which Phase 6 should absorb.

---

## Session 11 — 2026-08-31 — Phase 6: Model routing + economics

**What changed** (branch `feat/phase-6-economics`, commit `2a34cea`). Measured against
the Session 8 baseline, a simulated steady-state hour on the new `profiles/homelab.json`:

| | baseline | after |
|---|---|---|
| calls/hr | 1,160 | 633 |
| tokens/hr | 3.45M | 705k |
| local share | 0% | **93%** (bar was >70%) |
| cost/day/agent | ~$27 | ~$5.61 |

- `src/models/router.js` — six tiers (reflex/chat/plan/reflect/code/vision). All 10
  prompter call sites now declare a tier; the router resolves it, meters the call, and
  retries once on a genuinely different model if a provider fails. **Backwards
  compatible by construction:** with no `tiers` block in the profile, every tier
  resolves to exactly the model it used before.
- `src/models/metering.js` — per-tier/per-site tokens and cost with a rolling window
  and `localShare()`. Token counts are honest estimates (chars/4.21); real usage
  numbers would require touching all 20 provider classes, since `sendRequest` returns
  a bare string.
- **Event-driven prompting** replaced the fixed 2s idle poll — the single biggest
  source of volume (the loop ran at ~96% of its own cooldown ceiling, around the
  clock). The act tier now prompts when something actually happened and otherwise
  waits for a 45s heartbeat, so a stuck plan is still re-examined. ~786 → ~150
  conversing calls/hour, and this is most of the token win.
- Cheap audit wins: `getCommandDocs` memoized (~1,900 tokens rebuilt by string concat
  on *every* prompt); command output capped at 1,500 chars (`!searchWiki` returned
  entire wiki articles into history, then charged again for embedding and
  summarizing); default `embedding` is now `ollama` (it had been silently falling
  back to the paid chat provider, ~59k calls/day/agent); `code_timeout_mins` now
  defaults to 5 rather than unbounded.

**One design note worth carrying forward:** `router.js` deliberately does not import
`_model_map.js`. That module dynamically imports ~20 provider classes behind a
top-level await, so importing it from library code drags the entire provider surface
(and its native deps) along — it hung the test runner outright. The model factory is
injected by `prompter.js` instead. Treat `_model_map.js` as an application-edge module.

**Deliberately not done:** reordering `$COMMAND_DOCS` to the prompt head for provider
prefix caching (~45% token cut on paid calls). It changes prompt ordering and so model
behavior, and local-first routing made it largely moot — only ~46 calls/hour now reach
a cacheable paid provider. Revisit only if the live run shows the paid tiers hotter
than modeled.

**Verification:** 146/146 tests (17 new: routing resolution, fallback, metering
arithmetic, local-share windowing, event-driven cadence). Simulated economics run
above. No new lint errors. **Not live-verified** — same standing gap as phases 1-5.

**Next:** Phase 7 (observability + in-app configurability). It now carries real
inherited debt: profile-block editors for `drives`/`cognition`/`memory`/`skills`/
`social`/`tiers`, and dashboard rendering for cognition, memory, skills, social, and
the new economics payload — all of which `full_state.js` and the blackboard already
publish, with nothing yet reading them.

---

## Session 12 — 2026-08-31 — Phase 7: Observability + in-app configurability

**What changed** (branch `feat/phase-7-observability`, commit `93027d3`). This phase
existed to close the gap between "the agent publishes it" and "you can see it," plus
the UI-parity debt from every prior phase.

- **Sim view** (new tab beside Agents), `public/sim.js` + `sim.css`. Per agent: the
  active goal and which drive produced it, the current step with a progress rail, the
  last inner thought, and drive meters. Drive bars encode urgency by length in a
  single hue — the *pursued* drive is marked with a rail rather than recolored, so
  color follows the entity rather than its rank. Relationships use a diverging
  blue↔red scale around a neutral midpoint, which is the honest encoding for a signed
  disposition. Aggregate tiles cover agents, local-call share (status-colored against
  the 70% bar from Phase 6), calls/hr, cost/hr and /day, memories and beliefs, skills.
  TV mode scales everything up.
- **Live event feed** — new `agent-event` socket channel. Agents stream memory events
  above importance 0.5 to the mindserver, which relays to dashboard listeners. Event
  kind is carried by an icon glyph *and* the type label, never color alone.
- **Profile editor generated from a spec.** `public/profile_spec.json` describes every
  profile key (type, section, range, description); the editor builds its whole form
  from it and the mindserver filters incoming profiles against it. This is the
  mechanism the roadmap asked for — a future profile key gets UI by adding one row,
  not by writing form code. Covers drives, social, cognition, memory, skills, tiers,
  modes, model roles, and prompt templates.

**Verification:** 153/153 tests. The 7 new ones guard the spec mechanism itself,
cross-checking the editor's drives/tiers/modes lists against `DEFAULT_DRIVES`, the
router's `TIERS`, and `modes.js` — so adding a drive or tier can't silently leave it
unconfigurable. Render output was verified by executing `sim.js` against a stubbed DOM
with realistic state (bar widths, active/cooldown marking, diverging bars, progress
rail, event classification, XSS escaping, offline agents). HTML tag balance checked.
Palette validated with the dataviz validator: all six checks pass on the dark surface.

**Notes / limitations:**
- I could not screenshot the dashboard — the sandbox blocks binding a port, and there
  is no browser tool here. Markup and logic are verified; **visual layout is not**.
  Expect to nudge spacing on first view.
- Director mode (spectator camera following the most active agent) was listed optional
  and is deferred: tuning "most interesting" needs a live run to be worth anything.
- The Sim view re-renders wholesale on each 1s poll. Fine for 2-10 agents; if the
  feed or agent count grows, switch to targeted updates like the agent cards use.

**Next:** Phase 8 (research lab) — the last phase. It has the most existing
groundwork: `tools/trace.py` is the reference implementation, the memory event stream
is the substrate, and the `agent-event` channel added here is the live half of it.

---

## Session 13 — 2026-08-31 — Pre-first-run gate (phases 6-7)

Three reviewers; **one of them actually ran `node main.js`. It did not start.** That
alone justified the gate. All blockers and majors fixed in `cd4ae78`; 153/153 tests.

**The agent process was crashing before any of our code executed.** `agent.js` →
`vision_interpreter.js` → `camera.js` → `node-canvas-webgl` → the `gl` native addon,
which is unbuilt on this machine and on any Node >20, and which degenerates into an
uninterpretable `ERR_INTERNAL_ASSERTION` through the ESM→CJS translator. Vision is off
by default and the Camera was already built conditionally — it was the *static import*
that killed it. Now lazy. **This had nothing to do with phases 1-7 and would have
blocked the first run regardless.**

**Four more blockers:**
- An Ollama-only or Groq-only setup couldn't boot: the embedding model was built
  unguarded, failing with a message naming a provider the user never configured.
- The dashboard's `agentName is not defined` (my regression from `0bdab8d`) froze every
  agent card as offline with its controls disabled while stats ticked underneath.
- **Saving a profile disabled `self_preservation`.** No shipped personality profile
  defines `modes`, so unchecked boxes were written as `false`, and profile keys replace
  whole objects — the bot would stand in lava. Checkboxes now show the *effective*
  value and untouched inherited defaults aren't written.
- The profile editor had no scroll container; the Save button was clipped off-screen.

**Phase 6 correctness, all found by review:**
- Ollama swallowed transport errors and returned a sentinel *string*, so a dead local
  model metered as a successful free local call — the dashboard would read "100% local"
  while the bot chatted "My brain disconnected". This defeated the router's fallback
  *and* the phase's own acceptance metric. It now throws.
- `ActionManager.timedout` latched true forever on first timeout, after which
  interrupted actions stopped being treated as interrupted. Dormant until this phase
  changed `code_timeout_mins` from -1 to 5.
- Output truncation cut from the *front*, discarding exactly the tail that matters:
  `!newAction`'s "Code Output:" and the blueprint placement lists the MineCollab tasks
  depend on. Now keeps both ends.
- Liveness: queries never touch ActionManager and emit no `idle`, so an info-gathering
  turn left the act tier waiting for the heartbeat — stretching the "didn't act"
  watchdog from ~6s to 135s. And the heartbeat rode on `idle_ms`, which seven guard
  paths reset, so ambient activity could starve it forever. Now a dedicated
  accumulator, heartbeat 45s → 20s.

**First-run experience:** `open()` rejection would kill the mindserver 3s in on a
headless box; `EADDRINUSE` on 8080 gave a raw stack trace; and the single most common
first-run failure (server down/wrong port) printed `Disconnected: {}` because
`JSON.stringify(Error)` is `"{}"`. Also reverted my global `"embedding": "ollama"`
default — it silently degraded retrieval to word-overlap for every non-Ollama user.

**Security:** `set-profile` accepted nested filesystem keys (`memory.dir`,
`cognition.state_fp`) — arbitrary file write; used `in` (prototype chain) as its
filter; and ignored the spec's own min/max ranges.

**Docs corrected** because they actively misled: README's `--profiles` example named
files that don't exist, FAQ's `--no-optional` advice was wrong twice over, and
CLAUDE.md now states the **Node v18/v20 requirement** (v24 breaks native deps — which
is exactly what bit us here).

**Still true:** nothing is live-verified. But the known-blocking failures on the path
to a first run are now fixed, and the three most likely ones (no Minecraft server, no
Ollama, no API key) all produce a named, actionable error instead of a crash or a lie.

**Next:** Phase 8 (research lab).

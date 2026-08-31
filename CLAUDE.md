# CLAUDE.md

Fork of mindcraft-bots/mindcraft (`develop`). **Mission:** replace the shallow cognition
layer with a drive-based, memory-rich, multi-agent personality simulation that runs 24/7
on a homelab. The embodiment layer (mineflayer bindings, commands/library, model
providers, mindserver, vision, TTS) is good — do not rewrite that plumbing.

See `ROADMAP.md` for phases and `SESSIONS.md` for session handoffs.

## Repo map

- `main.js` — entry. Parses args/env, calls `Mindcraft.init()` then `Mindcraft.createAgent(settings)` per profile.
- `settings.js` — global config object (root). `src/agent/settings.js` is a *separate* empty singleton, populated in the agent child process via `setSettings()` with settings fetched from the mindserver over socket.io.
- `src/mindcraft/` — parent-process orchestrator + mindserver.
  - `mindcraft.js` — create/start/stop/destroy agents; assigns viewer ports (3000+i).
  - `mindserver.js` — express + socket.io on `mindserver_port` (8080). Registry of `AgentConnection`s; relays bot-to-bot chat; polls each in-game agent's `get-full-state` every 1s and broadcasts `state-update` to browser listeners.
  - `public/index.html` — the web dashboard shell: per-agent cards (status, health, inventory, viewer iframe, message box) plus a tab bar. Exposes `window.socket` for the modules below.
  - `public/sim.js` + `sim.css` — **Phase 7 Sim view**: per-agent goal/plan/drive meters, relationship polarity bars, aggregate stat tiles, live event feed, TV mode. Reads the same `state-update` payload as the cards, plus the `agent-event` channel. Colors follow the dataviz method — the categorical slots are validated against the dark surface; don't add hues without re-validating.
  - `public/profile_editor.js` + `profile_spec.json` — **the profile editor is generated from the spec.** To make a new profile key configurable in the browser, add a row to `profile_spec.json`; do not write form code. `test/mindcraft/profile_spec.test.js` cross-checks the drives/tiers/modes lists against the engine so new config can't silently lose its UI.
  - **Anything interpolated into dashboard HTML must be escaped** (`escapeHtml` in index.html, `esc` in the modules) — bot chat and agent names are attacker-influenced.
- `src/process/agent_process.js` — spawns `init_agent.js` per agent (own node process, `-n name -p port`); auto-restarts on nonzero exit unless it died <10s after spawn. Exit code >1 = task over, parent exits too.
- `src/agent/agent.js` — the agent core. `start()` wires mineflayer events; `handleMessage()` is the perceive→prompt→act loop (see below); `update()` runs every 300ms: `bot.modes.update()`, `self_prompter.update()`, `checkTaskDone()`.
- `src/agent/action_manager.js` — single execution slot for actions. `runAction(label, fn, {timeout, resume})`; new actions `stop()` the current one (interrupt flag + wait); detects fast/infinite action loops. **This is already the single-writer gate for the bot** — Phase 4's coherence bottleneck builds on it, not around it.
- `src/agent/commands/` — `index.js` (regex parser/dispatcher/docs), `queries.js` (14 read-only, return strings), `actions.js` (41, wrapped in `runAsAction` → action_manager). One command per LLM response; result string goes back into history as `system`. Args: numbers, bools, `"quoted strings"` only.
- `src/agent/library/` — `skills.js` (38 async primitives: craft, combat, movement, inventory, trade) and `world.js` (21 read-only sensors). Docstrings live *inside* the function body as `/** ... **/` (note `**/` terminator) — extracted via `toString()` by `library/index.js`; no docstring = invisible to generated code. `skill_library.js` embeds docs and retrieves by cosine similarity (word-overlap fallback). `full_state.js` builds the dashboard state snapshot. `lockdown.js` = SES sandbox.
- `src/agent/coder.js` — `!newAction` implementation: prompt for a codeblock, lint (unknown skills/learned calls + ESLint), run in an SES compartment exposing `{skills, world, log, Vec3}` plus (when `use_skill_library`) a lazy `learned` Proxy, up to 5 repair attempts. Injects `if(bot.interrupt_code) return;` after every statement for interruptibility. Code files saved to `bots/<name>/action-code/`. Near-identical tasks re-execute a stored skill directly before any codegen. NOTE: `library/lockdown.js` previously *never ran* SES lockdown (its wrapper recursed into its own guard) — fixed 2026-08-30; hardening is now real, watch for taming issues in libs that mutate intrinsics.
- `src/agent/skills/` — **Phase 3 learned-skill library**, gated by `settings.use_skill_library` (default off; requires `allow_insecure_coding`). `store.js` (per-agent `bots/<name>/skills/skills.json`), `library.js` (`LearnedSkills`: save-on-success with LLM docstring + embedding, dedup, similarity retrieval with word-overlap fallback, direct-execution thresholds, usage stats, composition namespace with cycle/depth guards). Learned docs rank in the same `$CODE_DOCS` pool as built-ins (`skill_library.js`). Profile block: `skills` (thresholds, max_skills, max_compose_depth). Tests in `test/skills/`.
- `src/agent/modes.js` — reflex tier. Priority-ordered list ticked every 300ms: self_preservation, unstuck, cowardice, self_defense, hunting, item_collecting, torch_placing, elbow_room, idle_staring. A triggering mode runs through action_manager (interrupting per its `interrupts` list) and can auto-reprompt the LLM about the interruption. Keep as the fast tier.
- `src/agent/self_prompter.js` — legacy autonomy: while active, injects `You are self-prompting with the goal: '<static string>'...` every ~2s of idle. Still drives the user-facing `!goal` command; user goals outrank cognition.
- `src/agent/cognition/` — **Phases 1+4 cognitive core**, gated by `settings.use_cognition` (default off). `drives.js` (pure drive state: personality weights, decay/satisfy, urgency), `arbiter.js` (drive selection with hysteresis, also drives mid-goal preemption), `monitor.js` (retry → replan → abandon; step timeouts count *active time* only), `planner.js` (LLM goal/plan generation + parsing), `sensors.js` (bot state → sensor levels, 1Hz), `blackboard.js` (shared agent state incl. consume-once interruption notes + tier telemetry), `scheduler.js` (cadenced tier dispatch: busy tiers skipped not queued, per-tier error isolation), `index.js` (`CognitionLoop` split into `planTick` ~1s and `actTick` ~300ms with separate busy guards — preemption/timeouts stay live during in-flight step LLM calls; coordination via `pending_replan` + `step_interrupt`). Tiers registered in `agent.startEvents`: reflex (modes, always first), act, plan, reflect (memory), social (Phase 5 placeholder). `action_manager.isReflexActive()` is the coherence-gate check — the act tier never fights a reflex for the slot; `modes.js` reports interruptions of deliberate actions → blackboard + memory event → re-assess note in the next step prompt. Steps execute through the normal `handleMessage` machinery; the model reports progress with `!stepDone`/`!stepFailed` (blacklisted when the flag is off). Profile keys: `drives`, `cognition` (loop tuning incl. `act_cadence_ms`/`plan_cadence_ms`) — see `profiles/wilbur.json`. State persists to `bots/<name>/cognition.json`. Unit tests: `npm test` (node:test, `test/cognition/`).
- `src/agent/history.js` — rolling chat buffer. At `max_messages` (15), the oldest 5 turns are LLM-summarized into a single ≤500-char `memory` string (lossy, overwritten each time) and appended to `bots/<name>/histories/`. Stays as the short-term buffer; long-term recall lives in `src/agent/memory/`.
- `src/agent/memory/` — **Phase 2 long-term memory**, gated by `settings.use_memory` (default off). `events.js` (typed taxonomy w/ importance defaults — covers trace.py's categories plus goal lifecycle and beliefs), `store.js` (append-only JSONL in `bots/<name>/memory/`, crash-tolerant), `scoring.js` (recency × relevance×2 × importance, pure), `index.js` (`AgentMemory`: record/retrieve/reflect; embeddings via profile embedding model with word-overlap degradation; background reflection into `belief` events once accumulated importance crosses a threshold). Emission points: agent.js (chat/speech/command/damage/death/session/narration), cognition (goal lifecycle), coder.js (successful code). Retrieval feeds `$MEMORY` (conversing) and `$RELEVANT_MEMORIES` (goal generation, task planning). Profile block: `memory` (retrieval_k, half_life_hours, weights, reflection_threshold). Tests in `test/memory/`.
- `src/agent/social/` — **Phase 5 social layer**, gated by `settings.use_social` (default off). `relationships.js` (pure per-pair trust/affinity/grudge, personality-scaled deltas, time decay), `gossip.js` (pure selection + trust-weighted credibility + attribution), `trade.js` (offer bookkeeping + fairness ratio modulated by relationship/generosity), `index.js` (`SocialModule`: durable store in `bots/<name>/social/`, interaction recording, `$SOCIAL` prompt context). **It is not a deliberative tier** — it never drives actions or competes for the action slot; it modulates the conversation prompt, and costs zero extra LLM calls (relationship math is pure, gossip comes from existing memories). Commands `!offerTrade`/`!acceptTrade`/`!declineTrade` (blocked when the flag is off). Profile block: `social` (trust_gain/trust_loss/forgiveness/warmth/gossip_propensity/generosity). See `profiles/wilbur.json` (open, forgiving) vs `profiles/greta.json` (hoarder, unforgiving). Tests in `test/social/`.
- `src/agent/memory_bank.js` — named-coordinate dict behind `!rememberHere`/`!savedPlaces`. Now durable: mirrors places into the memory event stream and hydrates from it on boot (`attachMemory`).
- `src/agent/conversation.js` — singleton convoManager for bot-to-bot chat (routed via mindserver, not in-game chat). Turn-taking heuristics + LLM `bot_responder` arbitration; pauses self-prompter during conversations; liveness monitor nudges stalled bots.
- `src/agent/npc/` — data-driven goal executor: item dependency-tree planner (`item_goal.js`), blueprint builder (`build_goal.js`, JSON blueprints in `construction/`), day/night routine. Scripted, not emergent; reads `profile.npc`. Loads blueprints with a cwd-relative path — run from repo root.
- `src/agent/tasks/` — MineCollab benchmark harness (`--task_path`/`--task_id`). Leave intact; useful for regression-testing cognition changes.
- `src/agent/vision/` — headless prismarine-viewer render → JPEG → vision model (`allow_vision`); `browser_viewer.js` is the human-facing 3D view.
- `src/models/` — 20 provider classes, duck-typed: `static prefix`, `constructor(model_name, url, params)`, `sendRequest(turns, systemMessage)`, optional `sendVisionRequest`/`embed`. `_model_map.js` auto-registers by scanning the dir (it dynamically imports every provider behind a top-level await — **don't import it from library code**, inject a factory instead). `prompter.js` orchestrates: merges profile (defaults/_default.json → base profile → individual), wires roles, owns all prompt templates (`$STATS`, `$MEMORY`, `$SOCIAL`, `$COMMAND_DOCS`, `$CODE_DOCS`, `$EXAMPLES`, ...). Embedding failures degrade to word-overlap scoring.
- `src/models/router.js` + `metering.js` — **Phase 6 tiered routing.** Six tiers (`reflex`, `chat`, `plan`, `reflect`, `code`, `vision`); every prompt call site declares one via `router.run(tier, site, fn)`. A profile's optional `tiers` block maps tier → model spec; **with no `tiers` block every tier resolves to the model it used before**, so existing profiles are unaffected. One retry on a different model if a provider fails. `metering.js` tracks per-tier/per-site tokens and cost (estimates: the provider interface returns a bare string) and `localShare()`. Reference config: `profiles/homelab.json`. Run summary logs on shutdown and hourly; `log_routing` traces individual calls.
- `profiles/` — personality profiles (JSON). Keys: `name`, `model` (string `"api/model"` or `{api, model, url, params}`), optional `code_model`/`vision_model`/`embedding`/`speak_model`, `modes` overrides, prompt templates, few-shot example arrays, optional `npc` seed. Shallow top-level merge — overriding `modes` replaces the whole object.
- `tools/trace.py` — offline behavioral-trace analyzer (stdlib Python): parses Paper server logs into typed events (speech / narration / command-by-kind / death / session) and renders a static HTML research report (timeline + hostile-pressure ridge, interaction ledger, who-addressed-whom matrix, resource flow, believed-vs-observed). Reference implementation for Phase 8's in-app reports.
- `bots/<name>/` — per-agent runtime state: `memory.json`, `histories/`, `action-code/`, `screenshots/`, `last_profile.json`. Per-agent persistence for new subsystems belongs here.

## The current loop (message → action)

1. Minecraft chat/whisper → mineflayer event → `agent.js respondFunc` → `handleMessage(source, message)`. Bot-to-bot messages arrive via mindserver socket → `convoManager.receiveFromBot` → (turn-taking delay) → `handleMessage`. System events (death, mode interruptions, self-prompt ticks) call `handleMessage('system', ...)`.
2. `handleMessage` appends to history, then loops up to `max_commands`: `prompter.promptConvo(history)` fills the `conversing` template (stats, inventory, command docs, retrieved examples, the summary `memory`) and calls the chat model.
3. If the response contains `!command(...)`: text after it is truncated, the command is parsed/validated and dispatched — queries return strings; actions run through `ActionManager` (interrupting whatever is running); `!newAction` invokes `coder.js`. The result string is appended as a `system` turn and the loop continues. No command → plain chat response, loop ends.
4. Every 300ms, `update()` ticks modes (reflexes can seize the action slot and later auto-reprompt) and the self-prompter (re-injects its static goal when idle ≥2s).
5. Action completion emits `idle`, which the NPC controller hooks for its scripted goal routine.

## Conventions

- ESM (`"type": "module"`), no TypeScript, no test framework currently in the repo.
- 4-space indent, single quotes, semicolons required. `snake_case` locals/settings, `camelCase` functions, `PascalCase` classes.
- Module-level singletons imported directly (`settings`, `convoManager`, `serverProxy`).
- Async/await throughout; mode `update()` must return in ~100ms — long work goes through `execute()`/action_manager.
- Lint: `npx eslint <files>` (eslint.config.js: `require-await`, `no-floating-promise`, `no-undef` are errors).
- Known quirks (match, don't "fix" casually): `prompter.skill_libary` typo (used across files), `NPCContoller` class name, in-body docstrings with `**/` terminator, cwd-relative paths (always run from repo root).
- Keys come from `keys.json` (gitignored) or env vars. **Never commit `keys.json`.**

## Running locally

```bash
cp keys.example.json keys.json   # fill in, or rely on Ollama only
# edit settings.js: host/port of the LAN Minecraft server, profiles list
node main.js                     # or: node main.js --profiles ./profiles/llama.json
```
Mindserver UI at http://localhost:8080. Ollama at default `http://127.0.0.1:11434`
(`"model": "ollama/<model>"`, `"embedding": "ollama"` → `embeddinggemma`). Docker:
`docker-compose.yml` (host networking; use `host.docker.internal` on Mac/Windows).

## Design pillars (the mission)

1. **Drive-based cognition, not prompt nagging** — weighted intrinsic drives (safety, food, curiosity, social standing, wealth) per personality; loop = arbitrate drives → goal → task tree → execute → observe → reflect/replan.
2. **Generative-Agents-style memory** — append-only event stream with importance; retrieval = recency × relevance × importance via embeddings; reflection synthesizes beliefs; persisted per agent.
3. **Voyager-style skill library** — successful coder.js programs stored with docstring + embedding, retrieved by task similarity, composed into higher-order skills.
4. **PIANO-style concurrency** — cadenced modules (reflex/act/plan/reflect/social) over a shared blackboard with a single-writer coherence gate on the bot.
5. **Social fabric** — per-pair trust/affinity/grudges, gossip with attribution, trade. Drama emerges from incompatible drives, never scripts.
6. **Token economics** — tiered routing (local Ollama → mid API → frontier), event-driven prompting instead of the 2s idle cadence, per-agent cost metering.
7. **Watchability & controllability** — dashboard shows each agent's drive, goal, plan step, last thought, relationships; later a director camera. The mindserver app at :8080 is the *primary control surface*: any new config (settings flag, profile key, tuning knob) ships with UI support in the same phase, and a user can create and fully configure an agent in the browser without touching JSON on disk.
8. **Research lab** — behavioral traces are a first-class product: typed events (deliberate speech vs auto-narration vs commands-by-kind vs deaths vs sessions vs goal/plan lifecycle) feed live and historical reports, scoped by agent/time/world/run, with named comparable runs and multi-world support. `tools/trace.py` is the offline reference implementation; if a behavior only appears in console logs, it doesn't exist to research.

Emergent over scripted, always. Target 2–4 agents now, 10+ as a config change.

## Working agreements

- **Plan first, every session.** State what you'll change and why; wait for Tom's go-ahead before large diffs.
- One feature branch per phase (`feat/phase-1-cognition`, ...), small conventional commits. Never commit `keys.json`.
- Don't break the existing command/profile API; deprecate gradually behind settings flags. Existing profiles must still boot.
- **UI parity:** new configuration lands in the :8080 app (settings_spec.json / profile editor) in the same phase that introduces it. **Events, not log lines:** new behaviors emit typed events so reports can see them.
- Match existing ESM style; run eslint before finishing.
- Tests: unit-test pure logic (drive arbitration, retrieval scoring, relationship updates). Integration: mock mineflayer or a disposable local server — never a public server.
- **Security is non-negotiable:** coder.js executes generated JS — keep the SES compartment's exposed surface minimal and audit anything added to it. Treat in-game chat as untrusted input (prompt injection). No new network egress from generated code. Containerized execution stays supported. Bots connect only to Tom's LAN server.

### Known security posture (audited 2026-08-31)

Understand these before adding features; they shape what is and isn't safe:
- **The SES compartment is a namespace boundary, not a security boundary.** With `evalTaming: 'unsafeEval'` and host functions endowed (`skills`, `world`, `learned`), generated code can reach the primal realm via constructor chains. Real isolation = the container. `allow_insecure_coding` means what its name says. `lockdown()` now runs at boot and **fails closed** (codegen refuses if hardening fails).
- **Any player on the server can invoke any non-blocked command**, including `!newAction`. Accepted for a trusted LAN; set `only_chat_with` when `allow_insecure_coding` is on.
- **The mindserver has no authentication** — localhost-bound, cross-origin sockets rejected, but any *local* process has full control (create/configure/destroy agents, inject chat as any player). Accepted for a single-user homelab; don't expose the port.
- **A custom `url` on a keyed provider sends your API key (and every prompt) to that host.** Upstream behavior; treat profile `model.url` as a credential-scope decision.
- Chat → memory → coding prompt → generated code → persisted skill is a real, durable path. Docstrings are sanitized and skills are schema-validated on load, but a prompt-injection that survives the model is *persistent*. Inspect `bots/<name>/skills/skills.json` if a bot starts behaving oddly.
- **Untrusted text must never be substituted before `replaceStrings` runs, and always via a function replacer** (`replaceAll(tok, () => v)`) so `$&`/`` $` ``/`$'` can't expand. Follow the existing pattern in `prompter.js`.
- Anything interpolated into the dashboard's HTML must go through `escapeHtml()`.
- End every session: update ROADMAP.md checkboxes, append a handoff note (what changed / what's next / known issues) to SESSIONS.md.
- Session resume ritual: read CLAUDE.md, ROADMAP.md, last entry of SESSIONS.md; report status and plan; wait for go-ahead.

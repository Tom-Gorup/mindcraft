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

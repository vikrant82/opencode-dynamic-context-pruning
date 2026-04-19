# Date
2026-04-19

# Session Summary

## Full Investigation Arc (Sessions 1-5)

### Sessions 1-2: Data analysis + initial debugging
- 100-session analysis: compression adds ~8,994 tokens avg (doesn't reduce), cache hit drops 87%→42%
- Tool outputs are 75% of context (find_symbol 13.3K, bash 10.2K, read 8K)
- Added debug logging to `syncCompressionBlocks` and `filterCompressedRanges`

### Session 3: Deep code path analysis + diagnostic build
- Exhaustive pipeline trace — injection runs but output unchanged in 95 snapshots
- All code verified correct in isolation
- Deployed 7 DIAG log points to test getter/proxy hypothesis

### Session 4: Diagnostic results + root cause + 3 optimizations implemented
**Diagnostic results:**
- `sameReference=true` — getter/proxy hypothesis WRONG, same array reference
- Compression IS working: `prePruneLen=20 → postPruneLen=7` (13 messages removed)
- Summary injection IS working: `summaryLength=7078` chars injected
- `saveContext` receives modified array correctly

**Real root cause: tools never pruned.** `pruneToolOutputs()` checks `state.prune.tools` which was nearly always EMPTY because strategies (`purgeErrors`, `deduplicate`) only ran during `prepareSession()` (compress tool execution), not during the regular hook. Completed tool outputs — 75% of context — were never marked for pruning.

**3 optimizations implemented:**
1. **Aggressive tool pruning** — New `staleTools` strategy (lib/strategies/stale-tools.ts) marks completed tool outputs older than N turns. All strategies now run in hook pipeline (inside `prune()`) not just during compress prep.
2. **Configurable summary budget** — `compress.summaryBudget` (chars) injected into compress tool prompt via `buildSummaryBudgetExtension()`. Default: 0 (disabled).
3. **Smarter nudge thresholds** — `compress.minSavingsThreshold` (tokens). If estimated compressible tokens below threshold and context only over min limit (not max), nudge skipped. Uses `estimateCompressibleTokens()`.

### Session 5: Testing, analysis, publish, skill creation
**Effectiveness analysis (session ses_25fc8e85bffe):**
- staleTools: 236 tools pruned (95,563 tokens). Continuous operation confirmed.
- summaryBudget=2000: 4/6 summaries compliant, 2 wildly over (13,595 and 9,978 chars — LLM doesn't always comply)
- minSavingsThreshold=5000: No evidence of firing (no logging existed). Added debug log.

**4 new debug logs added** (all behind `debug: true`):
1. `"Skipping compress nudge: savings below threshold"` in inject.ts
2. `"staleTools details"` in stale-tools.ts (tokens, tool names, totals)
3. `"Summary budget check"` in prune.ts (chars, budget, overage%)
4. `"Session metrics"` in hooks.ts (messageCount, turn, prunedTools, blocks, etc.)

**Enriched notifications** (v3.3.0): Compress notification shows per-compression net savings + reduction % + session totals. Prune notification shows batch count + session stats. All notifications are `ignored=true, noReply=true` (UI-only, no LLM context cost).

**Version logging** (v3.3.1): `index.ts` logs version from package.json in "DCP initialized" message.

**Fork & publish:**
- Forked to `vikrant82/opencode-dynamic-context-pruning`
- Package: `@vikrant82/opencode-dcp` on npm
- CI: `.github/workflows/release.yml` — triggers on `v*` tags, publishes with NPM_TOKEN
- v3.2.0 (optimizations), v3.3.0 (notifications), v3.3.1 (version logging) all published
- `opencode.json` updated to use npm package (not local path)

**DCP debug skill created** at `~/.agents/skills/dcp-debug/SKILL.md` (489 lines, 13 sections). Covers: file locations, debug mode, version verification, log analysis patterns, state file analysis, context snapshots, pipeline architecture, diagnostic logging, local dev workflow, release workflow, troubleshooting, config reference, source file reference.

**AGENTS.md updated** with §3.7 (Branching & Push Policy) and §3.8 (Commit Hygiene).

# Immediate Goal
Session complete. All planned work done. User keeping `debug: true` for a few more sessions to collect data.

# Completed
- Root cause identified and fixed (tools never pruned → staleTools strategy + strategies in hook pipeline)
- 3 optimizations implemented, tested, published (v3.2.0-3.3.1)
- Enriched notifications with session stats
- Version logging
- Fork to vikrant82, npm publish, CI pipeline
- DCP debug skill (exhaustive, 489 lines)
- AGENTS.md updates (branching policy, commit hygiene)
- All DIAG logs cleaned up
- 4 new debug logs added (behind debug flag)

# Open Loops
- **summaryBudget compliance**: LLM ignores budget for large summaries (2/6 over 5x budget). May need post-hoc truncation or stronger prompt engineering.
- **minSavingsThreshold**: Needs more data — no skip events observed yet. May need lower threshold or different trigger conditions.
- **Cache-aware compression (Opt 3)**: Deferred. Would skip compression when cache hit is high. Not implemented.
- **Monitor staleTools `turns: 3` setting**: May need tuning based on usage patterns.

# Key Decisions
- `get_feedback` added to DEFAULT_PROTECTED_TOOLS (code-level) and config protectedTools
- `read_memory` NOT blanket-protected — compression summaries capture the content, raw output redundant after 3 turns
- staleTools default: enabled, turns=3
- summaryBudget default: 0 (disabled) — user set to 2000
- minSavingsThreshold default: 0 (disabled) — user set to 5000
- Notifications are ignored=true (no LLM context cost)
- Used squash merges for all PRs

# Files Modified (this session, in DCP repo)
- `lib/strategies/stale-tools.ts` — NEW: staleTools strategy
- `lib/strategies/index.ts` — Added staleTools export
- `lib/messages/prune.ts` — Run strategies in prune(), summary budget check log, DIAG cleanup
- `lib/messages/inject/inject.ts` — minSavingsThreshold guard + skip log
- `lib/messages/inject/utils.ts` — estimateCompressibleTokens()
- `lib/prompts/extensions/tool.ts` — buildSummaryBudgetExtension()
- `lib/compress/range.ts` — Wired summary budget into prompt
- `lib/compress/message.ts` — Wired summary budget into prompt
- `lib/config.ts` — StaleTools, summaryBudget, minSavingsThreshold configs + get_feedback in DEFAULT_PROTECTED_TOOLS
- `lib/hooks.ts` — Session metrics debug log, DIAG cleanup
- `lib/logger.ts` — DIAG cleanup
- `lib/ui/notification.ts` — Enriched compress + prune notifications
- `lib/ui/utils.ts` — SessionStatsSnapshot, getSessionStatsSnapshot(), formatSessionStatsBlock()
- `index.ts` — Version logging
- `package.json` — v3.3.1, @vikrant82/opencode-dcp
- `README.md` — Fork docs
- `.github/workflows/release.yml` — CI publish pipeline

# Files Modified (outside DCP repo)
- `~/.config/opencode/opencode.json` — Plugin source: `@vikrant82/opencode-dcp` (npm)
- `~/.config/opencode/dcp.jsonc` — staleTools config, summaryBudget=2000, minSavingsThreshold=5000
- `~/.config/opencode/AGENTS.md` — §3.7 Branching, §3.8 Commit Hygiene
- `~/.agents/skills/dcp-debug/SKILL.md` — NEW: DCP debug skill (489 lines)

# Next Memories to Load
- `knowledge__architecture`
- `knowledge__coding_conventions`

# Resumption Prompt
DCP plugin work is stable. Fork at `vikrant82/opencode-dynamic-context-pruning`, published as `@vikrant82/opencode-dcp` (v3.3.1). opencode.json uses npm package. User has `debug: true` for ongoing observation.

Three optimizations shipped: staleTools (aggressive tool pruning), summaryBudget (compress summary size limit), minSavingsThreshold (skip nudges when savings negligible). All configurable via dcp.jsonc.

Open items: summaryBudget LLM compliance is ~67% (may need stronger prompting or post-hoc truncation), minSavingsThreshold needs data, cache-aware compression (Opt 3) deferred.

DCP debug skill at `~/.agents/skills/dcp-debug/SKILL.md` has exhaustive debugging reference (file locations, log patterns, state analysis, pipeline architecture, troubleshooting).

To resume DCP work: `cd ~/tasksync-mcp/opencode-dynamic-context-pruning`. Build: `npm run build`. Release: bump version, push, `gh release create v3.X.Y`.

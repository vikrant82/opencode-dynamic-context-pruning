# Date
2026-04-19

# Session Summary

## Session 6: Bug fixes, notifications, tuning, and DCP debug skill

### Critical bug: Plugin failed to load from npm (v3.3.1)
- `createRequire(import.meta.url)` failed in OpenCode's package cache (`~/.cache/opencode/packages/...`)
- Error: `Cannot find module './package.json'` in OpenCode system log (`~/.local/share/opencode/log/`)
- **Fix (v3.3.2):** Replaced with build-time version injection via tsup `define: { __DCP_VERSION__: JSON.stringify(pkg.version) }` in `tsup.config.ts`
- Also discovered: Bun must be installed for OpenCode to install npm plugins. Without Bun, install silently fails creating empty directories.
- Plugin cache paths: OLD `~/.cache/opencode/node_modules/` → NEW `~/.cache/opencode/packages/@scope/pkg@latest/node_modules/`

### Critical bug: Prune notifications never shown (v3.3.3)
- `sendUnifiedNotification` was defined in `notification.ts` but never imported/called anywhere
- `sendCompressNotification` was wired (called from `pipeline.ts:95`) but prune notification was orphaned
- **Fix:** `pruneToolOutputs` now returns newly-pruned tool IDs (checks `output !== PRUNED_TOOL_OUTPUT_REPLACEMENT`). `prune()` returns them. Hook handler calls `sendUnifiedNotification` after pruning.
- Added `workingDirectory` parameter to `createChatMessageTransformHandler` (passed from `ctx.directory` in index.ts)

### README updates
- Fork Improvements section now has JSONC config snippets for each feature
- Default Config block has `[FORK]` comments for staleTools, summaryBudget, minSavingsThreshold
- New Installation section: Bun prerequisite, two install methods, verification, troubleshooting
- Protected tools updated to include `get_feedback`

### DCP debug skill created
`~/.agents/skills/dcp-debug/SKILL.md` — 500+ lines, 13 sections. Covers file locations, log analysis, state/snapshot analysis, pipeline architecture, diagnostic logging, local dev, release workflow, troubleshooting, config reference, source file reference. Updated with correct cache paths and "Plugin not loading" troubleshooting.

### Turn counting discovery
DCP turns = `step-start` parts (LLM inference steps), NOT user messages. In feedback loop sessions with `get_feedback`, each tool call round-trip increments steps. `turns: 6` is ~3 user feedback cycles.

### Config tuning
- `summaryBudget`: 3000 → 0 (disabled). Tool pruning handles 95%+ of context reduction, summaries can be generous.
- `staleTools.turns`: 6 → 15. At turns=6, session was at 11% context (too aggressive). At turns=15, estimated ~30-35%.
- summaryBudget LLM compliance: still poor (75% over budget at 3000). Moot now since disabled.

### Live session analysis (ses_259b5d3c)
- Turn 26, 312 tools cached, 274 pruned, 510K tokens saved
- 2 compression blocks, 103 compressed messages
- Without DCP: 554K tokens (138% of 400K limit — would crash)
- minSavingsThreshold=5000 correctly suppressed nudge when compressibleTokens=0
- staleTools continuously pruning: read, grep, serena tools, todowrite all pruned after aging

### Releases
- v3.3.2: Fix createRequire crash, build-time version injection
- v3.3.3: Wire prune notifications into hook pipeline

# Immediate Goal
Session complete. Config tuned. Monitoring DCP with `debug: true` and new settings (turns=15, summaryBudget=0).

# Completed
- Fixed plugin load crash (createRequire → build-time define)
- Fixed missing prune notifications (wired sendUnifiedNotification)
- Updated README with config examples, Bun prerequisite, troubleshooting
- Created DCP debug skill (500+ lines, 13 sections)
- Discovered turn counting = step-start parts, not user messages
- Tuned staleTools.turns (6→15) and summaryBudget (3000→0)
- Updated handoff, debug skill with correct cache paths

# Open Loops
- **Monitor turns=15 effectiveness**: Need a few sessions to see if 30-35% context is achieved
- **minSavingsThreshold=5000**: Working (suppressed correctly) but may need tuning
- **Cache-aware compression (Opt 3)**: Still deferred
- **Summary quality**: Now uncapped (budget=0), monitor if summaries become too large

# Key Decisions
- Build-time version injection via tsup define (not runtime file resolution)
- `pruneToolOutputs` returns newly-pruned IDs (checks before replacing, not double-counting)
- summaryBudget=0: tool pruning handles context, let summaries be rich
- staleTools.turns=15: balance between context retention and headroom
- Bun is required for npm plugin installs in OpenCode

# Files Modified (DCP repo)
- `tsup.config.ts` — Added `define: { __DCP_VERSION__: ... }` with build-time version
- `index.ts` — Replaced createRequire with __DCP_VERSION__, added workingDirectory param
- `lib/hooks.ts` — Added workingDirectory param, sendUnifiedNotification call after prune
- `lib/messages/prune.ts` — `prune()` returns string[], `pruneToolOutputs` returns newly-pruned IDs
- `lib/ui/notification.ts` — No changes (was already correct, just not called)
- `package.json` — v3.3.3
- `README.md` — Config snippets, Bun prereq, install/verify/troubleshoot sections

# Files Modified (outside DCP repo)
- `~/.config/opencode/dcp.jsonc` — summaryBudget: 0, staleTools.turns: 15
- `~/.agents/skills/dcp-debug/SKILL.md` — Updated cache paths, added "Plugin not loading" section

# Next Memories to Load
- `knowledge__architecture`
- `knowledge__coding_conventions`

# Resumption Prompt
DCP plugin is at v3.3.3 on npm (`@vikrant82/opencode-dcp`). Two critical bugs fixed this session: plugin load crash (createRequire, v3.3.2) and missing prune notifications (v3.3.3). Config tuned: staleTools.turns=15, summaryBudget=0. debug=true for monitoring.

Key discovery: DCP "turns" = LLM inference steps (step-start parts), not user messages. In feedback loops, turns increment ~2x per user interaction.

DCP debug skill at `~/.agents/skills/dcp-debug/SKILL.md` has exhaustive reference. Plugin cache: `~/.cache/opencode/packages/@vikrant82/opencode-dcp@latest/`. Bun required for npm plugin installs.

To resume: `cd ~/tasksync-mcp/opencode-dynamic-context-pruning`. Build: `npm run build`. Release: bump version → push → `gh release create v3.X.Y`.

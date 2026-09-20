/**
 * DCP Prune/Unprune command handlers.
 * On-demand, LLM-free pruning of old tool outputs with batch-aware undo.
 *
 * Usage:
 *   /dcp prune --older-than 150 [--tools serena_*,codebase-memory-*] [--dry-run]
 *   /dcp prune --older-than 1 --top-5
 *   /dcp prune --older-than 1 --indexes 1,3-5
 *   /dcp unprune [--all]
 */
import type { Logger } from "../logger"
import type { SessionState, ToolParameterEntry, WithParts } from "../state"
import type { PluginConfig } from "../config"
import { isToolNameProtected } from "../protected-patterns"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams, getTotalToolTokens } from "../token-utils"
import { saveSessionState } from "../state/persistence"
import { syncToolCache } from "../state/tool-cache"

export interface PruneCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
    workingDirectory: string
}

export interface UnpruneCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export interface PruneCandidate {
    id: string
    entry: ToolParameterEntry
}

export interface PruneSkips {
    protected: number
    builtinSkip: number
    compressed: number
    alreadyPruned: number
}

export interface PruneResolution {
    candidates: PruneCandidate[]
    skips: PruneSkips
    globMatched: number
    youngestEligibleAge: number | null
}

const BUILTIN_SKIP_TOOLS = new Set(["question", "edit", "write"])

export function collectCoveredToolIds(state: SessionState, messages: WithParts[]): Set<string> {
    const covered = new Set<string>()
    for (const msg of messages) {
        const entry = state.prune.messages.byMessageId.get(msg.info.id)
        if (!entry || entry.activeBlockIds.length === 0) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part.type === "tool" && part.callID) {
                covered.add(part.callID)
            }
        }
    }
    return covered
}

export function resolvePruneCandidates(
    state: SessionState,
    config: PluginConfig,
    messages: WithParts[],
    options: { olderThan: number; toolGlobs?: string[] },
): PruneResolution {
    const explicit = !!options.toolGlobs && options.toolGlobs.length > 0
    const covered = collectCoveredToolIds(state, messages)
    const skips: PruneSkips = { protected: 0, builtinSkip: 0, compressed: 0, alreadyPruned: 0 }
    const candidates: PruneCandidate[] = []
    let globMatched = 0
    let youngestEligibleAge: number | null = null
    for (const [id, entry] of state.toolParameters) {
        const age = state.currentTurn - entry.turn
        if (age < options.olderThan) {
            continue
        }
        if (entry.status !== "completed" && entry.status !== "error") {
            continue
        }
        if (youngestEligibleAge === null || age < youngestEligibleAge) {
            youngestEligibleAge = age
        }
        if (explicit) {
            if (!isToolNameProtected(entry.tool, options.toolGlobs!)) {
                continue
            }
            globMatched++
        } else {
            if (BUILTIN_SKIP_TOOLS.has(entry.tool)) {
                skips.builtinSkip++
                continue
            }
            if (isToolNameProtected(entry.tool, config.commands.protectedTools)) {
                skips.protected++
                continue
            }
        }
        if (covered.has(id)) {
            skips.compressed++
            continue
        }
        if (state.prune.tools.has(id)) {
            skips.alreadyPruned++
            continue
        }
        candidates.push({ id, entry })
    }
    return { candidates, skips, globMatched, youngestEligibleAge }
}

export const MAX_PRUNE_BATCHES = 20

export interface ParsedPruneArgs {
    olderThan?: number
    toolGlobs?: string[]
    indexes?: number[]
    topN?: number
    dryRun: boolean
    error?: string
}

export interface ToolGroup {
    tool: string
    count: number
    tokens: number
    ids: string[]
}

export function parseIndexSpec(spec: string): { indexes?: number[]; error?: string } {
    const indexes = new Set<number>()
    const parts = spec
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    if (parts.length === 0) {
        return { error: "--indexes requires values like 1,2,3 or 1-5" }
    }
    for (const part of parts) {
        const rangeMatch = part.match(/^(\d+)-(\d+)$/)
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10)
            const end = parseInt(rangeMatch[2], 10)
            if (start < 1 || end < start) {
                return { error: `Invalid index range: ${part}` }
            }
            for (let i = start; i <= end; i++) indexes.add(i)
        } else if (/^\d+$/.test(part)) {
            const n = parseInt(part, 10)
            if (n < 1) {
                return { error: `Index must be >= 1: ${part}` }
            }
            indexes.add(n)
        } else {
            return { error: `Invalid index spec: ${part} (use numbers or ranges like 1-5)` }
        }
    }
    return { indexes: [...indexes].sort((a, b) => a - b) }
}

export function parsePruneArgs(args: string[]): ParsedPruneArgs {
    const parsed: ParsedPruneArgs = { dryRun: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "--older-than") {
            const raw = args[++i]
            const value = raw !== undefined ? Number(raw) : NaN
            if (!Number.isInteger(value) || value < 1) {
                return {
                    dryRun: false,
                    error: "--older-than requires a positive integer (LLM steps)",
                }
            }
            parsed.olderThan = value
        } else if (arg === "--tools") {
            const raw = args[++i]
            if (!raw) {
                return { dryRun: false, error: "--tools requires comma-separated tool globs" }
            }
            const globs = raw
                .split(",")
                .map((g) => g.trim())
                .filter(Boolean)
            if (globs.length === 0) {
                return { dryRun: false, error: "--tools requires comma-separated tool globs" }
            }
            parsed.toolGlobs = globs
        } else if (arg === "--indexes") {
            const raw = args[++i]
            if (!raw) {
                return { dryRun: false, error: "--indexes requires values like 1,2,3 or 1-5" }
            }
            const spec = parseIndexSpec(raw)
            if (spec.error) {
                return { dryRun: false, error: spec.error }
            }
            parsed.indexes = spec.indexes
        } else if (/^--top-\d+$/.test(arg)) {
            parsed.topN = parseInt(arg.slice("--top-".length), 10)
        } else if (arg === "--dry-run") {
            parsed.dryRun = true
        } else {
            return { dryRun: false, error: `Unknown option: ${arg}` }
        }
    }
    if (parsed.olderThan === undefined) {
        return { dryRun: parsed.dryRun, error: "Missing required --older-than <steps>" }
    }
    if (parsed.indexes && parsed.topN !== undefined) {
        return { dryRun: parsed.dryRun, error: "--indexes and --top-N are mutually exclusive" }
    }
    return parsed
}

const PRUNE_USAGE = [
    "Usage: /dcp prune --older-than <steps> [--tools <globs>] [--indexes <list> | --top-N] [--dry-run]",
    "",
    "  --older-than <steps>  Prune completed/errored tool outputs aged ≥ <steps> LLM steps",
    "  --tools <globs>       Comma-separated tool-name globs; explicit selection overrides protection",
    "  --indexes <list>      Select rows by index from the eligible table (e.g. 1,3 or 1-5 or 1,3-5)",
    "  --top-N               Select the top N rows by estimated tokens (e.g. --top-5)",
    "  --dry-run             List candidates + estimated savings without pruning",
    "",
    "  --indexes and --top-N are mutually exclusive; both compose with --tools.",
    "",
    "Example: /dcp prune --older-than 150 --tools serena_*,codebase-memory-* --dry-run",
    "Example: /dcp prune --older-than 1 --top-5",
    "Example: /dcp prune --older-than 1 --indexes 1,3-5",
].join("\n")

function boxLines(title: string): string[] {
    return [
        "╭───────────────────────────────────────────────────────────╮",
        `│${title.padEnd(59)}│`,
        "╰───────────────────────────────────────────────────────────╯",
        "",
    ]
}

export function buildOrderedGroups(candidates: PruneCandidate[]): ToolGroup[] {
    const groups = new Map<string, ToolGroup>()
    for (const { id, entry } of candidates) {
        const group = groups.get(entry.tool) ?? { tool: entry.tool, count: 0, tokens: 0, ids: [] }
        group.count += 1
        group.tokens += entry.tokenCount ?? 0
        group.ids.push(id)
        groups.set(entry.tool, group)
    }
    return [...groups.values()].sort((a, b) => b.tokens - a.tokens)
}

export function selectGroupsByIndex(groups: ToolGroup[], indexes: number[]): ToolGroup[] {
    const selected: ToolGroup[] = []
    for (const idx of indexes) {
        if (idx >= 1 && idx <= groups.length) {
            selected.push(groups[idx - 1])
        }
    }
    return selected
}

function skipSummary(skips: PruneSkips, explicit: boolean): string[] {
    const parts: string[] = []
    if (skips.compressed > 0) parts.push(`${skips.compressed} already inside compression blocks`)
    if (skips.alreadyPruned > 0) parts.push(`${skips.alreadyPruned} already pruned`)
    if (!explicit) {
        if (skips.protected > 0) parts.push(`${skips.protected} protected`)
        if (skips.builtinSkip > 0) parts.push(`${skips.builtinSkip} question/edit/write`)
    }
    return parts
}

function formatDryRunMessage(
    resolution: PruneResolution,
    parsed: ParsedPruneArgs,
    totalTokens: number,
    groups: ToolGroup[],
    selectedIndexes: Set<number> | null,
): string {
    const lines = boxLines("                 DCP Prune (dry-run)")
    lines.push(
        `Eligible: ${resolution.candidates.length} tool(s) older than ${parsed.olderThan} steps`,
    )
    groups.forEach((group, i) => {
        const idx = i + 1
        const marker = selectedIndexes?.has(idx) ? " ←" : ""
        lines.push(
            `  ${String(idx).padStart(2)}  ${group.tool.padEnd(24)} ×${String(group.count).padStart(3)}   ~${group.tokens.toLocaleString()} tok${marker}`,
        )
    })
    const parts = skipSummary(resolution.skips, !!parsed.toolGlobs)
    if (parts.length > 0) {
        lines.push(`  Skipped: ${parts.join(", ")}`)
    }
    lines.push(`  Estimated savings: ~${totalTokens.toLocaleString()} tokens`)
    lines.push("")
    lines.push("Run without --dry-run to apply · /dcp unprune reverts the batch")
    return lines.join("\n")
}

function formatCommitMessage(count: number, batchId: number, totalTokens: number): string {
    const lines = boxLines("                      DCP Prune")
    lines.push(
        `Pruned ${count} tool(s) — batch #${batchId}, ~${totalTokens.toLocaleString()} tokens, effective on next request`,
    )
    lines.push("/dcp unprune = revert this batch · /dcp unprune --all = revert all manual prunes")
    return lines.join("\n")
}

function formatNoCandidatesMessage(
    state: SessionState,
    resolution: PruneResolution,
    parsed: ParsedPruneArgs,
): string {
    const lines = boxLines("                      DCP Prune")
    if (state.currentTurn < parsed.olderThan!) {
        lines.push(
            `No candidates yet: session is only ${state.currentTurn} steps old (need ≥ ${parsed.olderThan}).`,
        )
        return lines.join("\n")
    }
    if (parsed.toolGlobs && resolution.globMatched === 0) {
        lines.push(`No tools matched: ${parsed.toolGlobs.join(", ")}`)
        return lines.join("\n")
    }
    lines.push("Nothing to prune.")
    const parts = skipSummary(resolution.skips, !!parsed.toolGlobs)
    if (parts.length > 0) {
        lines.push(`Skipped: ${parts.join(", ")}`)
    }
    return lines.join("\n")
}

export async function handlePruneCommand(ctx: PruneCommandContext): Promise<void> {
    const { client, state, config, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)
    const parsed = parsePruneArgs(args)
    if (parsed.error) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `${parsed.error}\n\n${PRUNE_USAGE}`,
            params,
            logger,
        )
        return
    }
    syncToolCache(state, config, logger, messages)
    const resolution = resolvePruneCandidates(state, config, messages, {
        olderThan: parsed.olderThan!,
        toolGlobs: parsed.toolGlobs,
    })
    if (resolution.candidates.length === 0) {
        const message = formatNoCandidatesMessage(state, resolution, parsed)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        logger.info("Prune command: no candidates", { skips: resolution.skips })
        return
    }
    const groups = buildOrderedGroups(resolution.candidates)
    const hasIndexSelection = parsed.indexes !== undefined || parsed.topN !== undefined
    let effectiveCandidates = resolution.candidates
    let selectedIndexSet: Set<number> | null = null
    if (hasIndexSelection) {
        const indexes =
            parsed.topN !== undefined
                ? Array.from({ length: Math.min(parsed.topN, groups.length) }, (_, i) => i + 1)
                : parsed.indexes!
        const outOfRange = indexes.filter((i) => i > groups.length)
        if (outOfRange.length > 0) {
            const message = `Index ${outOfRange.join(", ")} out of range (only ${groups.length} group(s) eligible)`
            await sendIgnoredMessage(client, sessionId, message, params, logger)
            return
        }
        selectedIndexSet = new Set(indexes)
        const selectedGroups = selectGroupsByIndex(groups, indexes)
        const selectedIds = new Set(selectedGroups.flatMap((g) => g.ids))
        effectiveCandidates = resolution.candidates.filter((c) => selectedIds.has(c.id))
    }
    if (effectiveCandidates.length === 0) {
        await sendIgnoredMessage(client, sessionId, "Selection matched no tools.", params, logger)
        return
    }
    const candidateIds = effectiveCandidates.map((c) => c.id)
    const totalTokens = getTotalToolTokens(state, candidateIds)
    if (parsed.dryRun) {
        const message = formatDryRunMessage(resolution, parsed, totalTokens, groups, selectedIndexSet)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        logger.info("Prune command: dry-run", { candidates: candidateIds.length, totalTokens })
        return
    }
    for (const { id, entry } of effectiveCandidates) {
        state.prune.tools.set(id, entry.tokenCount ?? 0)
        state.prune.notifiedToolIds.add(id)
        if (parsed.toolGlobs) {
            state.prune.explicitTools.add(id)
        }
    }
    const batchId = (state.prune.batches[state.prune.batches.length - 1]?.id ?? 0) + 1
    const selectorParts = [`older-than ${parsed.olderThan}`]
    if (parsed.toolGlobs) selectorParts.push(`tools: ${parsed.toolGlobs.join(",")}`)
    if (parsed.indexes) selectorParts.push(`indexes: ${parsed.indexes.join(",")}`)
    if (parsed.topN !== undefined) selectorParts.push(`top: ${parsed.topN}`)
    const selector = selectorParts.join(", ")
    state.prune.batches.push({
        id: batchId,
        at: new Date().toISOString(),
        selector,
        toolIds: candidateIds,
        estTokens: totalTokens,
    })
    if (state.prune.batches.length > MAX_PRUNE_BATCHES) {
        state.prune.batches.shift()
    }
    state.stats.pruneTokenCounter += totalTokens
    state.stats.totalPruneTokens += state.stats.pruneTokenCounter
    state.stats.pruneTokenCounter = 0
    try {
        await saveSessionState(state, logger)
    } catch (err: any) {
        logger.error("Failed to persist state after prune", { error: err?.message })
    }
    const message = formatCommitMessage(effectiveCandidates.length, batchId, totalTokens)
    await sendIgnoredMessage(client, sessionId, message, params, logger)
    logger.info("Prune command completed", {
        tools: candidateIds.length,
        totalTokens,
        batchId,
        selector,
    })
}

const UNPRUNE_USAGE = "Usage: /dcp unprune [--all]"

export async function handleUnpruneCommand(ctx: UnpruneCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages, args } = ctx
    const params = getCurrentParams(state, messages, logger)
    const unknown = args.find((a) => a !== "--all")
    if (unknown) {
        await sendIgnoredMessage(
            client,
            sessionId,
            `Unknown option: ${unknown}\n\n${UNPRUNE_USAGE}`,
            params,
            logger,
        )
        return
    }
    if (state.prune.batches.length === 0) {
        await sendIgnoredMessage(client, sessionId, "No manual prunes to revert.", params, logger)
        return
    }
    const all = args.includes("--all")
    const batches = all
        ? [...state.prune.batches]
        : [state.prune.batches[state.prune.batches.length - 1]]
    let restored = 0
    let restoredTokens = 0
    for (const batch of batches) {
        for (const id of batch.toolIds) {
            const tokens = state.prune.tools.get(id)
            if (state.prune.tools.delete(id)) {
                state.prune.explicitTools.delete(id)
                state.prune.notifiedToolIds.delete(id)
                restored++
                restoredTokens += tokens ?? 0
            }
        }
    }
    state.prune.batches = all ? [] : state.prune.batches.slice(0, -1)
    state.stats.totalPruneTokens = Math.max(0, state.stats.totalPruneTokens - restoredTokens)
    try {
        await saveSessionState(state, logger)
    } catch (err: any) {
        logger.error("Failed to persist state after unprune", { error: err?.message })
    }
    const lines = boxLines("                     DCP Unprune")
    if (all) {
        lines.push(
            `Restored ${restored} tool(s) from ${batches.length} batch(es) (~${restoredTokens.toLocaleString()} tokens return on next request)`,
        )
    } else {
        lines.push(
            `Restored ${restored} tool(s) from batch #${batches[0].id} (~${restoredTokens.toLocaleString()} tokens return on next request) · ${state.prune.batches.length} batch(es) remain`,
        )
    }
    await sendIgnoredMessage(client, sessionId, lines.join("\n"), params, logger)
    logger.info("Unprune command completed", { restored, restoredTokens, all })
}

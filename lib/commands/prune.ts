/**
 * DCP Prune/Unprune command handlers.
 * On-demand, LLM-free pruning of old tool outputs with batch-aware undo.
 *
 * Usage:
 *   /dcp prune --older-than 150 [--tools serena_*,codebase-memory-*] [--dry-run]
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
    dryRun: boolean
    error?: string
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
        } else if (arg === "--dry-run") {
            parsed.dryRun = true
        } else {
            return { dryRun: false, error: `Unknown option: ${arg}` }
        }
    }
    if (parsed.olderThan === undefined) {
        return { dryRun: parsed.dryRun, error: "Missing required --older-than <steps>" }
    }
    return parsed
}

const PRUNE_USAGE = [
    "Usage: /dcp prune --older-than <steps> [--tools <glob,glob,…>] [--dry-run]",
    "",
    "  --older-than <steps>  Prune completed/errored tool outputs aged ≥ <steps> LLM steps",
    "  --tools <globs>       Comma-separated tool-name globs; explicit selection overrides protection",
    "  --dry-run             List candidates + estimated savings without pruning",
    "",
    "Example: /dcp prune --older-than 150 --tools serena_*,codebase-memory-* --dry-run",
].join("\n")

function boxLines(title: string): string[] {
    return [
        "╭───────────────────────────────────────────────────────────╮",
        `│${title.padEnd(59)}│`,
        "╰───────────────────────────────────────────────────────────╯",
        "",
    ]
}

function groupByTool(candidates: PruneCandidate[]): Map<string, { count: number; tokens: number }> {
    const groups = new Map<string, { count: number; tokens: number }>()
    for (const { entry } of candidates) {
        const group = groups.get(entry.tool) ?? { count: 0, tokens: 0 }
        group.count += 1
        group.tokens += entry.tokenCount ?? 0
        groups.set(entry.tool, group)
    }
    return groups
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
): string {
    const lines = boxLines("                 DCP Prune (dry-run)")
    lines.push(
        `Eligible: ${resolution.candidates.length} tool(s) older than ${parsed.olderThan} steps`,
    )
    const groups = [...groupByTool(resolution.candidates).entries()].sort(
        (a, b) => b[1].tokens - a[1].tokens,
    )
    for (const [tool, group] of groups) {
        lines.push(
            `  ${tool.padEnd(24)} ×${String(group.count).padStart(3)}   ~${group.tokens.toLocaleString()} tok`,
        )
    }
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
    const candidateIds = resolution.candidates.map((c) => c.id)
    const totalTokens = getTotalToolTokens(state, candidateIds)
    if (parsed.dryRun) {
        const message = formatDryRunMessage(resolution, parsed, totalTokens)
        await sendIgnoredMessage(client, sessionId, message, params, logger)
        logger.info("Prune command: dry-run", { candidates: candidateIds.length, totalTokens })
        return
    }
    for (const { id, entry } of resolution.candidates) {
        state.prune.tools.set(id, entry.tokenCount ?? 0)
        if (parsed.toolGlobs) {
            state.prune.explicitTools.add(id)
        }
    }
    const batchId = (state.prune.batches[state.prune.batches.length - 1]?.id ?? 0) + 1
    const selector = parsed.toolGlobs
        ? `older-than ${parsed.olderThan}, tools: ${parsed.toolGlobs.join(",")}`
        : `older-than ${parsed.olderThan}`
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
    const message = formatCommitMessage(resolution.candidates.length, batchId, totalTokens)
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

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

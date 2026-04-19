import { PluginConfig } from "../config"
import { Logger } from "../logger"
import type { SessionState, WithParts } from "../state"
import {
    getFilePathsFromParameters,
    isFilePathProtected,
    isToolNameProtected,
} from "../protected-patterns"

/**
 * Stale Tools strategy - prunes tool outputs for completed tools
 * that are older than a configurable number of turns.
 *
 * Unlike purgeErrors (which targets errored tools), this targets
 * successful tool calls whose outputs are no longer needed because
 * the conversation has moved on.
 *
 * Modifies the session state in place to add pruned tool call IDs.
 */
export const staleTools = (
    state: SessionState,
    logger: Logger,
    config: PluginConfig,
    messages: WithParts[],
): void => {
    if (state.manualMode && !config.manualMode.automaticStrategies) {
        return
    }

    if (!config.strategies.staleTools.enabled) {
        return
    }

    const allToolIds = state.toolIdList
    if (allToolIds.length === 0) {
        return
    }

    const unprunedIds = allToolIds.filter((id) => !state.prune.tools.has(id))

    if (unprunedIds.length === 0) {
        return
    }

    const protectedTools = config.strategies.staleTools.protectedTools
    const turnThreshold = Math.max(1, config.strategies.staleTools.turns)

    const newPruneIds: string[] = []

    for (const id of unprunedIds) {
        const metadata = state.toolParameters.get(id)
        if (!metadata) {
            continue
        }

        // Skip protected tools
        if (isToolNameProtected(metadata.tool, protectedTools)) {
            continue
        }

        const filePaths = getFilePathsFromParameters(metadata.tool, metadata.parameters)
        if (isFilePathProtected(filePaths, config.protectedFilePatterns)) {
            continue
        }

        // Only target completed (successful) tools
        if (metadata.status !== "completed") {
            continue
        }

        // Check if the tool is old enough to prune
        const turnAge = state.currentTurn - metadata.turn
        if (turnAge >= turnThreshold) {
            newPruneIds.push(id)
        }
    }

    if (newPruneIds.length > 0) {
        let prunedTokens = 0
        const toolNames: string[] = []
        for (const id of newPruneIds) {
            const entry = state.toolParameters.get(id)
            const tokens = entry?.tokenCount ?? 0
            prunedTokens += tokens
            state.prune.tools.set(id, tokens)
            if (entry?.tool && !toolNames.includes(entry.tool)) {
                toolNames.push(entry.tool)
            }
        }
        state.stats.totalPruneTokens += prunedTokens
        logger.info(
            `Marked ${newPruneIds.length} stale tool outputs for pruning (older than ${turnThreshold} turns)`,
        )
        logger.debug("staleTools details", {
            prunedTokens,
            tools: toolNames,
            totalPrunedTools: state.prune.tools.size,
            totalPruneTokens: state.stats.totalPruneTokens,
        })
    }
}

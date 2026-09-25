import type { WithParts } from "../state"
import { ensureSessionInitialized, refreshManualMode } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
    state: ToolContext["state"]
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)
    const state = ctx.stateStore
        ? await ctx.stateStore.ensureInitialized(toolCtx.sessionID, (sessionState) =>
              ensureSessionInitialized(
                  ctx.client,
                  sessionState,
                  toolCtx.sessionID,
                  ctx.logger,
                  rawMessages,
                  ctx.config.manualMode.enabled,
              ),
          )
        : ctx.state!
    await refreshManualMode(state, toolCtx.sessionID, ctx.logger, ctx.config.manualMode.enabled)

    if (state.manualMode && state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

    assignMessageRefs(state, rawMessages)

    deduplicate(state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(state, rawMessages),
        state,
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
    state = ctx.state!,
): Promise<void> {
    state.manualMode = state.manualMode ? "active" : false
    applyPendingCompressionDurations(state)
    await saveSessionState(state, ctx.logger)

    const params = getCurrentParams(state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
    )
}

import { randomUUID, createHash } from "node:crypto"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PluginConfig } from "./config"
import type { Logger } from "./logger"
import {
    checkSession,
    saveSessionState,
    syncToolCache,
    type SessionState,
    type SessionStateStore,
    type WithParts,
} from "./state"
import { isMessageCompacted } from "./state/utils"
import { filterMessages } from "./messages/shape"
import { createSyntheticUserMessage } from "./messages/utils"
import { getLastUserMessage } from "./messages/query"
import {
    parsePruneArgs,
    resolvePruneCandidates,
    resolveReasoningCandidates,
    buildOrderedGroups,
    MAX_PRUNE_BATCHES,
    type ParsedPruneArgs,
} from "./commands/prune"
import { countTokens } from "./token-utils"
import {
    PRUNED_TOOL_OUTPUT_REPLACEMENT,
    PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
    PRUNED_QUESTION_INPUT_REPLACEMENT,
} from "./messages/prune"
import { resolvePruneHostPermission, type HostPermissionSnapshot } from "./host-permissions"
import type { PermissionRuleset } from "@opencode-ai/sdk/v2"

interface Context {
    client: any
    stateStore: SessionStateStore
    logger: Logger
    config: PluginConfig
    hostPermissions: HostPermissionSnapshot
}

const caveat =
    "Reasoning is selected by all or explicit --reasoning, only saves context on models retaining prior reasoning, and cannot be restored by current /dcp unprune."
const fingerprint = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Latest valid reported prompt only; generation/reasoning never contribute. Read-only. */
export function reportedPrompt(
    state: SessionState,
    messages: WithParts[],
): { tokens: number; key: string; messageID: string } | undefined {
    for (const message of [...messages].reverse()) {
        if (message.info.time.created < state.lastCompaction) continue
        const reports = [...message.parts]
            .reverse()
            .filter((p) => p.type === "step-finish")
            .map((p: any) => ({ tokens: p.tokens, id: p.id }))
        if (message.info.role === "assistant")
            reports.unshift({ tokens: message.info.tokens, id: message.info.id })
        for (const report of reports) {
            const t = report.tokens
            if (!t) continue
            const values = [t.input, t.cache?.read ?? 0, t.cache?.write ?? 0]
            if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0))
                continue
            const tokens = values.reduce((a, b) => a + b, 0)
            if (tokens > 0)
                return {
                    tokens,
                    key: `${message.info.id}:${report.id}:${fingerprint(values)}`,
                    messageID: message.info.id,
                }
        }
    }
}

function parse(args: string): ParsedPruneArgs {
    let words = args.trim().split(/\s+/).filter(Boolean)
    if (words[0]?.toLowerCase() === "all") {
        words = words.slice(1)
        if (words.includes("--indexes")) throw new Error("all does not accept --indexes")
        if (!words.some((w) => w.startsWith("--top-"))) words.unshift("--top-5")
        if (!words.includes("--tools")) words.unshift("--tools", "*")
        if (!words.includes("--reasoning")) words.unshift("--reasoning")
    }
    if (!words.includes("--older-than")) words.unshift("--older-than", "1")
    const parsed = parsePruneArgs(words)
    if (parsed.error) throw new Error(parsed.error)
    return parsed
}

function netSavings(part: any): number {
    if (part.state.status === "error") {
        return Object.values(part.state.input ?? {}).reduce<number>(
            (sum, value) =>
                sum +
                (typeof value === "string"
                    ? countTokens(value) - countTokens(PRUNED_TOOL_ERROR_INPUT_REPLACEMENT)
                    : 0),
            0,
        )
    }
    let savings = part.state.time?.compacted
        ? 0
        : countTokens(part.state.output ?? "") - countTokens(PRUNED_TOOL_OUTPUT_REPLACEMENT)
    if (part.tool === "question" && part.state.input?.questions !== undefined)
        savings +=
            countTokens(JSON.stringify(part.state.input.questions)) -
            countTokens(JSON.stringify(PRUNED_QUESTION_INPUT_REPLACEMENT))
    return savings
}

function selection(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    messages: WithParts[],
    parsed: ParsedPruneArgs,
) {
    // Resolve current status/age from the source, never from an old cache or slash preview.
    const fresh = { ...state, toolParameters: new Map() }
    syncToolCache(fresh, config, logger, messages)
    const candidates = resolvePruneCandidates(fresh, config, messages, {
        olderThan: parsed.olderThan!,
        toolGlobs: parsed.toolGlobs,
    }).candidates
    const parts = new Map<string, any>()
    for (const message of messages) {
        if (isMessageCompacted(state, message)) continue
        for (const part of message.parts)
            if (part.type === "tool" && part.tool !== "dcp_prune")
                parts.set(part.callID, { messageID: message.info.id, part })
    }
    const targetTools =
        !!parsed.toolGlobs || !!parsed.indexes || parsed.topN !== undefined || !parsed.reasoning
    let tools = (targetTools ? candidates : [])
        .filter((c) => parts.has(c.id))
        .map((c) => ({ ...c, entry: { ...c.entry, tokenCount: netSavings(parts.get(c.id).part) } }))
    const groups = buildOrderedGroups(tools)
    if (parsed.indexes?.some((i) => i > groups.length))
        throw new Error("Index out of range in current selection")
    const selectedGroups = parsed.indexes
        ? parsed.indexes.map((i) => groups[i - 1])
        : parsed.topN !== undefined
          ? groups.slice(0, parsed.topN)
          : groups
    const ids = new Set(selectedGroups.flatMap((g) => g.ids))
    tools = tools.filter((c) => ids.has(c.id))
    const potential = resolveReasoningCandidates(state, messages, parsed.olderThan!)
    const reasoning = parsed.reasoning ? potential : []
    const reasoningParts = new Map(
        messages.flatMap((m) =>
            m.parts
                .filter((p) => p.type === "reasoning")
                .map((p) => [p.id, { messageID: m.info.id, part: p }] as const),
        ),
    )
    return {
        tools,
        reasoning,
        groups: selectedGroups,
        savings: tools.reduce((sum, c) => sum + (c.entry.tokenCount ?? 0), 0),
        potential: potential.reduce((sum, c) => sum + c.tokenCount, 0),
        frozen: new Map([
            ...tools.map((c) => [`tool:${c.id}`, fingerprint(parts.get(c.id))] as const),
            ...reasoning.map(
                (c) => [`reasoning:${c.id}`, fingerprint(reasoningParts.get(c.id))] as const,
            ),
        ]),
    }
}

function describe(s: ReturnType<typeof selection>, prompt?: { tokens: number }): string {
    return [
        "DCP prune opportunity (dry-run)",
        "# tool | calls | estimated net tokens",
        ...s.groups.map((g, i) => `${i + 1} ${g.tool} | ${g.count} | ${g.tokens}`),
        `Last reported prompt: ${prompt?.tokens ?? "unavailable"} tokens`,
        `Estimated net tool savings: ${s.savings} tokens${prompt ? ` (${((s.savings / prompt.tokens) * 100).toFixed(1)}%)` : ""}`,
        `Reasoning potential separately: ${s.potential} tokens (not included in tool savings).`,
        caveat,
    ].join("\n")
}

/** Opt-in pruning tool. Serializes proposals per session and applies only unchanged frozen IDs.
 * Dry runs are read-only except normal initialization/cache sync. SDK/approval errors propagate.
 */
export function createAgentPruneTool(ctx: Context): ToolDefinition {
    return tool({
        description:
            "Prune old tool outputs with human approval. args: all, --older-than N, --tools globs, --indexes rows, --top-N, --reasoning, --dry-run. Plain args respects protections; all matches /dcp prune all: age 1, wildcard tools, top 5 groups and reasoning by default. Override age, tools or top-N as needed; explicit flags without top-N select all matching groups. Dry-run is optional. " +
            caveat,
        args: { args: tool.schema.string() },
        async execute({ args }, toolCtx) {
            if (!ctx.config.prune.enabled || ctx.config.prune.permission === "deny")
                throw new Error("DCP prune disabled")
            const parsed = parse(args)
            const fetch = async () =>
                filterMessages(
                    (await ctx.client.session.messages({ path: { id: toolCtx.sessionID } })).data,
                )
            const messages = await fetch()
            const state = await checkSession(
                ctx.client,
                ctx.stateStore,
                ctx.logger,
                messages,
                ctx.config.manualMode.enabled,
            )
            if (!state || state.sessionId !== toolCtx.sessionID || state.isSubAgent)
                throw new Error("Session unavailable or subagent pruning disabled")
            const pattern = `batch:${randomUUID()}`
            const permitted = async () => {
                const response = await ctx.client.session.get({ path: { id: toolCtx.sessionID } })
                if (!response.data || response.error)
                    throw new Error("Session permissions unavailable")
                const action = resolvePruneHostPermission(
                    ctx.hostPermissions,
                    toolCtx.agent,
                    pattern,
                    response.data.permission ?? [],
                )
                if (
                    !ctx.config.prune.enabled ||
                    action === "allow" ||
                    action === "deny" ||
                    ctx.config.prune.permission === "deny"
                )
                    throw new Error(
                        `DCP prune requires host ask permission (effective ${action ?? ctx.config.prune.permission})`,
                    )
            }
            await permitted()
            syncToolCache(state, ctx.config, ctx.logger, messages)
            const s = selection(state, ctx.config, ctx.logger, messages, parsed)
            const description = describe(s, reportedPrompt(state, messages))
            if (parsed.dryRun) return description
            if (s.frozen.size === 0) throw new Error("No meaningful eligible selection")
            if (state.pruneEpisode?.pending) throw new Error("A prune approval is already pending")
            state.pruneEpisode ??= { compaction: state.lastCompaction }
            state.pruneEpisode.pending = pattern
            try {
                try {
                    await toolCtx.ask({
                        permission: "dcp_prune",
                        patterns: [pattern],
                        always: [],
                        metadata: {
                            selection: s.groups.map(({ tool, count, tokens }) => ({
                                tool,
                                count,
                                tokens,
                            })),
                            savings: s.savings,
                            reasoning: { count: s.reasoning.length, caveat },
                        },
                    })
                } catch (error) {
                    const rejectionNames = [
                        "RejectedError",
                        "CorrectedError",
                        "PermissionRejectedError",
                        "PermissionCorrectedError",
                    ]
                    if (
                        rejectionNames.includes((error as any)?.name) ||
                        rejectionNames.includes((error as any)?._tag)
                    ) {
                        const prompt = reportedPrompt(state, await fetch())
                        state.pruneEpisode = {
                            baseline: prompt?.tokens,
                            compaction: state.lastCompaction,
                        }
                        await saveSessionState(state, ctx.logger)
                    }
                    throw error
                }
                const current = await fetch()
                const currentState = await checkSession(
                    ctx.client,
                    ctx.stateStore,
                    ctx.logger,
                    current,
                    ctx.config.manualMode.enabled,
                )
                await permitted()
                if (
                    currentState !== state ||
                    state.isSubAgent ||
                    toolCtx.abort.aborted ||
                    state.pruneEpisode?.pending !== pattern
                )
                    throw new Error("Prune proposal invalidated")
                const fresh = selection(state, ctx.config, ctx.logger, current, {
                    ...parsed,
                    indexes: undefined,
                    topN: s.tools.length ? Number.MAX_SAFE_INTEGER : undefined,
                })
                for (const [id, hash] of s.frozen)
                    if (fresh.frozen.get(id) !== hash)
                        throw new Error("Prune targets changed or unavailable; nothing pruned")
                for (const c of s.tools) {
                    state.prune.tools.set(c.id, c.entry.tokenCount ?? 0)
                    state.prune.notifiedToolIds.add(c.id)
                    if (parsed.toolGlobs) state.prune.explicitTools.add(c.id)
                }
                for (const c of s.reasoning) state.prune.reasoning.set(c.id, c.tokenCount)
                if (s.tools.length) {
                    state.prune.batches.push({
                        id: (state.prune.batches.at(-1)?.id ?? 0) + 1,
                        at: new Date().toISOString(),
                        selector: args,
                        toolIds: s.tools.map((c) => c.id),
                        estTokens: s.savings,
                    })
                    if (state.prune.batches.length > MAX_PRUNE_BATCHES) state.prune.batches.shift()
                }
                state.stats.totalPruneTokens += s.savings
                state.prune.preview = null
                state.pruneEpisode = {
                    compaction: state.lastCompaction,
                    awaitingReportAfter: reportedPrompt(state, current)?.key ?? "",
                }
                await saveSessionState(state, ctx.logger)
                return `Pruned ${s.tools.length} tool outputs and ${s.reasoning.length} reasoning parts; effective next request.\n${description}`
            } finally {
                if (state.pruneEpisode?.pending === pattern) state.pruneEpisode.pending = undefined
            }
        },
    })
}

/** Append an ephemeral outbound-tail opportunity once per growth episode.
 * Reserves suppression synchronously before persistence; pending approvals never overlap nudges.
 */
export async function appendPruneNudge(
    state: SessionState,
    config: PluginConfig,
    logger: Logger,
    host: HostPermissionSnapshot,
    messages: WithParts[],
    sessionRules: PermissionRuleset = [],
): Promise<void> {
    const n = config.prune?.nudge
    if (
        !config.prune?.enabled ||
        config.prune.permission === "deny" ||
        !n?.enabled ||
        state.isSubAgent
    )
        return
    const user = getLastUserMessage(messages)
    const agent = user?.info.role === "user" ? user.info.agent : undefined
    const hostAction = resolvePruneHostPermission(
        host,
        agent,
        `batch:${randomUUID()}`,
        sessionRules,
    )
    if (hostAction === "deny" || hostAction === "allow") return
    const prompt = reportedPrompt(state, messages)
    if (!prompt || !user) return
    state.pruneEpisode ??= { compaction: state.lastCompaction }
    const episode = state.pruneEpisode
    if (episode.pending) return
    if (episode.notifiedReportKey === prompt.key) return
    if (episode.awaitingReportAfter !== undefined) {
        if (!episode.appliedHistoryIds || episode.appliedHistoryIds.includes(prompt.messageID))
            return
        episode.baseline = prompt.tokens
        delete episode.awaitingReportAfter
        delete episode.appliedHistoryIds
        await saveSessionState(state, logger)
        return
    }
    if (
        prompt.tokens <= n.contextThreshold ||
        (episode.baseline !== undefined && prompt.tokens - episode.baseline < n.growthTokens)
    )
        return
    const s = selection(state, config, logger, messages, {
        olderThan: n.olderThan,
        toolGlobs: n.tools.length ? n.tools : undefined,
        dryRun: true,
    })
    if (!s.tools.length || s.savings / prompt.tokens < n.minSavingsRatio) return
    episode.baseline = prompt.tokens
    episode.notifiedReportKey = prompt.key
    const directArgs = `--older-than ${n.olderThan}${n.tools.length ? ` --tools ${n.tools.join(",")}` : ` --top-${s.groups.length}`} --reasoning`
    const alias =
        n.olderThan === 1 && n.tools.length === 1 && n.tools[0] === "*"
            ? ' Alternatively args "all" selects only the top 5 tool groups plus reasoning (same as /dcp prune all).'
            : ""
    const text = `${describe(s, prompt)}\nUse dcp_prune directly with args "${directArgs}" to request human approval for all matching tool groups plus eligible reasoning.${alias} Optionally add --dry-run for a read-only estimate first; --indexes, --top-N or --tools can narrow the selection. Human approval is required before pruning; unexposed host runtime allow rules can bypass native prompts. Do not assume approval.`
    messages.push(createSyntheticUserMessage(user, text, `prune-opportunity:${prompt.key}`))
    await saveSessionState(state, logger)
}

/** Record the outbound application boundary before awaiting any SDK work.
 * Existing assistant reports belong to pre-prune requests; only new assistant IDs can rebase.
 * Compaction clears this session-local persisted boundary with the episode.
 */
export function markPruneOutboundApplication(state: SessionState, messages: WithParts[]): boolean {
    const episode = state.pruneEpisode
    if (episode?.awaitingReportAfter !== undefined && !episode.appliedHistoryIds) {
        episode.appliedHistoryIds = messages.map((m) => m.info.id)
        return true
    }
    return false
}

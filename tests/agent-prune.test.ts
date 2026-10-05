import "./prune-env"
import assert from "node:assert/strict"
import test from "node:test"
import { createAgentPruneTool, appendPruneNudge, reportedPrompt } from "../lib/agent-prune"
import {
    SessionStateStore,
    createSessionState,
    ensureSessionInitialized,
    saveSessionState,
    type WithParts,
} from "../lib/state"
import { resetOnCompaction } from "../lib/state/utils"
import { prune, PRUNED_TOOL_OUTPUT_REPLACEMENT } from "../lib/messages/prune"
import { buildPruneConfig, testLogger } from "./prune-helpers"
import { countTokens } from "../lib/token-utils"
import { register } from "node:module"
import { createChatMessageTransformHandler } from "../lib/hooks"
import { PromptStore } from "../lib/prompts/store"
import { handleUnpruneCommand } from "../lib/commands/prune"

// Match the existing config integration tests: load the library's published ESM source.
register(
    `data:text/javascript,${encodeURIComponent(`
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
export async function load(url, context, next) {
    if (url.includes("/node_modules/jsonc-parser/lib/esm/") && url.endsWith(".js")) {
        return { format: "module", source: await readFile(fileURLToPath(url), "utf-8"), shortCircuit: true }
    }
    return next(url, context)
}`)}`,
)
const { validateConfigTypes, getInvalidConfigKeys } = await import("../lib/config")

let sequence = 0
function fixture() {
    const id = `ses_agent_prune_${process.pid}_${++sequence}`
    const config = buildPruneConfig({ protectedTools: ["edit", "skill"] })
    config.prune.enabled = true
    config.prune.nudge.contextThreshold = 100
    config.prune.nudge.minSavingsRatio = 0.2
    config.prune.nudge.growthTokens = 50
    const logger = testLogger()
    const stateStore = new SessionStateStore()
    const hostPermissions = { global: { dcp_prune: "ask" as const }, agents: {} }
    let messages: WithParts[] = [
        {
            info: {
                id: "user1",
                sessionID: id,
                role: "user",
                agent: "build",
                time: { created: 1 },
            },
            parts: [{ type: "text", text: "start" }],
        } as any,
        {
            info: {
                id: "assistant1",
                sessionID: id,
                role: "assistant",
                time: { created: 2 },
                tokens: {
                    input: 110,
                    output: 999999,
                    reasoning: 888888,
                    cache: { read: 20, write: 10 },
                },
            },
            parts: [
                { type: "step-start" },
                { type: "reasoning", id: "reason1", text: "old thinking ".repeat(50) },
                {
                    type: "tool",
                    id: "part1",
                    callID: "call1",
                    tool: "read",
                    state: {
                        status: "completed",
                        input: { giant: "input ".repeat(5000) },
                        output: "output ".repeat(200),
                        time: { start: 1, end: 2 },
                    },
                },
            ],
        } as any,
        {
            info: {
                id: "user2",
                sessionID: id,
                role: "user",
                agent: "build",
                time: { created: 3 },
            },
            parts: [{ type: "text", text: "next" }],
        } as any,
        {
            info: { id: "assistant2", sessionID: id, role: "assistant", time: { created: 4 } },
            parts: [{ type: "step-start" }],
        } as any,
    ]
    const client = {
        session: {
            messages: async () => ({ data: structuredClone(messages) }),
            get: async () => ({ data: {} }),
        },
    }
    const ctx = { client, config, logger, stateStore, hostPermissions }
    const tool = createAgentPruneTool(ctx)
    const toolCtx = {
        sessionID: id,
        messageID: "current",
        agent: "build",
        directory: "/tmp",
        worktree: "/tmp",
        abort: new AbortController().signal,
        metadata() {},
        ask: async (_request: any) => {},
    }
    return {
        id,
        config,
        logger,
        stateStore,
        hostPermissions,
        client,
        tool,
        toolCtx,
        get messages() {
            return messages
        },
        set messages(v) {
            messages = v
        },
    }
}

test("dry run estimates removed output only and changes no pruning state or permission", async () => {
    const f = fixture()
    const result = await f.tool.execute(
        { args: "--dry-run" },
        {
            ...f.toolCtx,
            ask: async () => {
                throw new Error("must not ask")
            },
        },
    )
    const state = f.stateStore.get(f.id)
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.prune.reasoning.size, 0)
    assert.deepEqual(state.prune.batches, [])
    assert.equal(state.prune.preview, null)
    assert.equal(state.stats.totalPruneTokens, 0)
    assert.equal(state.pruneEpisode, undefined)
    assert.deepEqual(f.hostPermissions.global, { dcp_prune: "ask" })
    assert.match(
        result,
        new RegExp(
            `Estimated net tool savings: ${countTokens("output ".repeat(200)) - countTokens(PRUNED_TOOL_OUTPUT_REPLACEMENT)} tokens`,
        ),
    )
    assert.match(result, /Last reported prompt: 140 tokens/)
    assert.doesNotMatch(result, /input input/)
})

test("approval freezes IDs and excludes outputs arriving while waiting", async () => {
    const f = fixture()
    let request: any
    await f.tool.execute(
        { args: "--indexes 1" },
        {
            ...f.toolCtx,
            ask: async (r) => {
                request = r
                f.messages[1].parts.push({
                    ...structuredClone(f.messages[1].parts[2] as any),
                    id: "part_new",
                    callID: "new",
                })
            },
        },
    )
    const state = f.stateStore.get(f.id)
    assert.deepEqual([...state.prune.tools.keys()], ["call1"])
    assert.deepEqual(state.prune.batches[0].toolIds, ["call1"])
    assert.deepEqual(request.always, [])
    assert.equal(request.permission, "dcp_prune")
    assert.match(request.patterns[0], /^batch:/)
    assert.deepEqual(
        request.metadata.selection.map((g: any) => [g.tool, g.count]),
        [["read", 1]],
    )
    const outbound = structuredClone(f.messages)
    prune(state, f.logger, f.config, outbound)
    assert.equal((outbound[1].parts[2] as any).state.output, PRUNED_TOOL_OUTPUT_REPLACEMENT)
    assert.equal((outbound[1].parts[3] as any).state.output, "output ".repeat(200))
})

test("target mutation after approval fails closed", async () => {
    const f = fixture()
    await assert.rejects(
        f.tool.execute(
            { args: "" },
            {
                ...f.toolCtx,
                ask: async () => {
                    ;(f.messages[1].parts[2] as any).state.output = "changed"
                },
            },
        ),
        /changed or unavailable/,
    )
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
    assert.deepEqual(f.stateStore.get(f.id).prune.batches, [])
})

test("permission rejection prunes nothing and rearms only after reported growth", async () => {
    const f = fixture()
    await assert.rejects(
        f.tool.execute(
            { args: "" },
            {
                ...f.toolCtx,
                ask: async () => {
                    throw Object.assign(new Error("declined"), { name: "RejectedError" })
                },
            },
        ),
    )
    const state = f.stateStore.get(f.id)
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
    let outbound = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, outbound)
    assert.equal(outbound.length, 4)
    ;(f.messages[1].info as any).tokens.input = 160
    outbound = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, outbound)
    assert.equal(outbound.length, 5)
})

test("nonpermission failures do not record a decline baseline", async () => {
    const f = fixture()
    await assert.rejects(
        f.tool.execute(
            { args: "" },
            {
                ...f.toolCtx,
                ask: async () => {
                    throw new Error("transport")
                },
            },
        ),
    )
    assert.equal(f.stateStore.get(f.id).pruneEpisode?.baseline, undefined)
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
})

test("all matches slash defaults and includes eligible reasoning implicitly", async () => {
    const f = fixture()
    await f.tool.execute({ args: "all" }, f.toolCtx)
    assert.deepEqual([...f.stateStore.get(f.id).prune.tools.keys()], ["call1"])
    assert.deepEqual([...f.stateStore.get(f.id).prune.reasoning.keys()], ["reason1"])
})

test("host-cleared completed output contributes no nudge savings or prune stats", async () => {
    const f = fixture()
    ;(f.messages[1].parts[2] as any).state.time.compacted = 9
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, outbound)
    assert.equal(outbound.length, 4)
    await f.tool.execute({ args: "" }, f.toolCtx)
    assert.equal(state.stats.totalPruneTokens, 0)
})

test("late pre-prune usage cannot establish baseline before the pruned request report", async () => {
    const f = fixture()
    f.config.compress.permission = "deny"
    ;(f.messages[0].info as any).model = { providerID: "test", modelID: "test" }
    ;(f.messages[2].info as any).model = { providerID: "test", modelID: "test" }
    await f.tool.execute({ args: "" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    ;(f.messages[3].info as any).tokens = { input: 260000, cache: { read: 0, write: 0 } }
    await appendPruneNudge(
        state,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(state.pruneEpisode?.baseline, undefined)
    const history = structuredClone(f.messages)
    f.messages.push({
        info: { id: "assistant_pruned", sessionID: f.id, role: "assistant", time: { created: 5 } },
        parts: [],
    } as any)
    const handler = createChatMessageTransformHandler(
        f.client,
        f.stateStore,
        f.logger,
        f.config,
        new PromptStore(f.logger, "/tmp", false),
        f.hostPermissions,
        "/tmp",
    )
    await handler({}, { messages: history })
    assert.equal(state.pruneEpisode?.baseline, undefined)
    ;(f.messages[4].info as any).tokens = { input: 190000, cache: { read: 0, write: 0 } }
    await appendPruneNudge(
        state,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(state.pruneEpisode?.baseline, 190000)
})

test("explicit reasoning removes eligible reasoning and leaves tools alone", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--reasoning" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    assert.deepEqual([...state.prune.reasoning.keys()], ["reason1"])
    assert.equal(state.prune.tools.size, 0)
    const outbound = structuredClone(f.messages)
    prune(state, f.logger, f.config, outbound)
    assert.deepEqual(
        outbound[1].parts.map((p) => p.type),
        ["step-start", "tool"],
    )
})

test("reported prompt totals exclude generation and honor compaction cutoff", () => {
    const f = fixture()
    const state = createSessionState()
    assert.equal(reportedPrompt(state, f.messages)?.tokens, 140)
    state.lastCompaction = 3
    assert.equal(reportedPrompt(state, f.messages), undefined)
})

test("nudge is a one-request tail addition with growth suppression and isolated sessions", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    const first = structuredClone(f.messages)
    await Promise.all([
        appendPruneNudge(state, f.config, f.logger, f.hostPermissions, first),
        appendPruneNudge(state, f.config, f.logger, f.hostPermissions, structuredClone(f.messages)),
    ])
    assert.equal(first.length, 5)
    assert.equal(f.messages.length, 4)
    assert.match((first.at(-1)!.parts[0] as any).text, /human approval/)
    const next = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, next)
    assert.equal(next.length, 4)
    const other = createSessionState()
    other.currentTurn = 2
    const isolated = structuredClone(f.messages)
    await appendPruneNudge(other, f.config, f.logger, f.hostPermissions, isolated)
    assert.equal(isolated.length, 5)
})

test("strict threshold excludes equality and permits first notification above", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    f.config.prune.nudge.contextThreshold = 140
    const state = f.stateStore.get(f.id)
    const equal = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, equal)
    assert.equal(equal.length, 4)
    ;(f.messages[1].info as any).tokens.input = 111
    const above = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, above)
    assert.equal(above.length, 5)
})

test("approval baseline waits for a subsequent report rather than old prompt", async () => {
    const f = fixture()
    await f.tool.execute({ args: "" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    await appendPruneNudge(
        state,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(state.pruneEpisode?.baseline, undefined)
    ;(f.messages[0].info as any).model = { providerID: "test", modelID: "test" }
    ;(f.messages[2].info as any).model = { providerID: "test", modelID: "test" }
    const handler = createChatMessageTransformHandler(
        f.client,
        f.stateStore,
        f.logger,
        f.config,
        new PromptStore(f.logger, "/tmp", false),
        f.hostPermissions,
        "/tmp",
    )
    await handler({}, { messages: structuredClone(f.messages) })
    f.messages.push({
        info: {
            id: "post_prune",
            sessionID: f.id,
            role: "assistant",
            time: { created: 5 },
            tokens: { input: 90, cache: { read: 0, write: 0 } },
        },
        parts: [],
    } as any)
    await appendPruneNudge(
        state,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(state.pruneEpisode?.baseline, 90)
})

test("notification suppression survives restart and resets on compaction", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    await appendPruneNudge(
        state,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    await saveSessionState(state, f.logger)
    const restarted = createSessionState()
    await ensureSessionInitialized(
        { session: { get: async () => ({ data: {} }) } },
        restarted,
        f.id,
        f.logger,
        f.messages,
        false,
    )
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(restarted, f.config, f.logger, f.hostPermissions, outbound)
    assert.equal(outbound.length, 4)
    resetOnCompaction(restarted)
    assert.equal(restarted.pruneEpisode, undefined)
})

test("effective host allow and deny block tool execution and nudges", async () => {
    for (const permission of ["allow", "deny"] as const) {
        const f = fixture()
        ;(f.hostPermissions.global as any).dcp_prune = permission
        await assert.rejects(f.tool.execute({ args: "" }, f.toolCtx), /requires host ask/)
        const outbound = structuredClone(f.messages)
        await appendPruneNudge(
            f.stateStore.get(f.id),
            f.config,
            f.logger,
            f.hostPermissions,
            outbound,
        )
        assert.equal(outbound.length, 4)
        assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
    }
})

test("config validates opt-in fields and rejects allow and invalid ratios", () => {
    const f = fixture()
    assert.deepEqual(validateConfigTypes({ prune: f.config.prune }), [])
    assert.deepEqual(getInvalidConfigKeys({ prune: f.config.prune }), [])
    assert.deepEqual(
        validateConfigTypes({
            prune: { permission: "allow", nudge: { minSavingsRatio: 1.1 } },
        }).map((e) => e.key),
        ["prune.permission", "prune.nudge.minSavingsRatio"],
    )
})

test("missing targets after approval fail closed", async () => {
    const f = fixture()
    await assert.rejects(
        f.tool.execute(
            { args: "" },
            {
                ...f.toolCtx,
                ask: async () => {
                    f.messages[1].parts.splice(2, 1)
                },
            },
        ),
        /changed or unavailable/,
    )
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
})

test("pending approval prevents overlapping proposals and nudges", async () => {
    const f = fixture()
    let release!: () => void
    let asked!: () => void
    const ready = new Promise<void>((resolve) => {
        asked = resolve
    })
    const pending = new Promise<void>((resolve) => {
        release = resolve
    })
    const first = f.tool.execute(
        { args: "" },
        {
            ...f.toolCtx,
            ask: async () => {
                asked()
                await pending
            },
        },
    )
    await ready
    await assert.rejects(f.tool.execute({ args: "" }, f.toolCtx), /already pending/)
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(f.stateStore.get(f.id), f.config, f.logger, f.hostPermissions, outbound)
    assert.equal(outbound.length, 4)
    release()
    await first
})

test("self-protected dcp_prune outputs survive wildcard selection and automatic pruning", async () => {
    const f = fixture()
    ;(f.messages[1].parts[2] as any).tool = "dcp_prune"
    await assert.rejects(f.tool.execute({ args: "--tools *" }, f.toolCtx), /No meaningful/)
    const state = f.stateStore.get(f.id)
    state.prune.tools.set("call1", 200)
    state.prune.explicitTools.add("call1")
    const outbound = structuredClone(f.messages)
    prune(state, f.logger, f.config, outbound)
    assert.equal((outbound[1].parts[2] as any).state.output, "output ".repeat(200))
})

test("session permission allows and denies are rejected before approval", async () => {
    for (const action of ["allow", "deny"] as const) {
        const f = fixture()
        f.client.session.get = async () =>
            ({
                data: { permission: [{ permission: "dcp_prune", pattern: "batch:*", action }] },
            }) as any
        await assert.rejects(
            f.tool.execute(
                { args: "" },
                {
                    ...f.toolCtx,
                    ask: async () => {
                        throw new Error("unexpected ask")
                    },
                },
            ),
            /requires host ask/,
        )
        assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
    }
})

test("session permission changes while waiting fail closed", async () => {
    const f = fixture()
    await assert.rejects(
        f.tool.execute(
            { args: "" },
            {
                ...f.toolCtx,
                ask: async () => {
                    f.client.session.get = async () =>
                        ({
                            data: {
                                permission: [
                                    { permission: "dcp_prune", pattern: "*", action: "allow" },
                                ],
                            },
                        }) as any
                },
            },
        ),
        /requires host ask/,
    )
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
    assert.equal(f.stateStore.get(f.id).stats.totalPruneTokens, 0)
})

test("unavailable session permissions fail closed without recording a decline", async () => {
    const f = fixture()
    f.client.session.get = async () => {
        throw new Error("transport unavailable")
    }
    await assert.rejects(f.tool.execute({ args: "" }, f.toolCtx), /transport unavailable/)
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
    assert.equal(f.stateStore.get(f.id).pruneEpisode, undefined)
})

test("custom nudge selectors propose direct scoped pruning and optional preview", async () => {
    const f = fixture()
    f.config.prune.nudge.tools = ["read"]
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(f.stateStore.get(f.id), f.config, f.logger, f.hostPermissions, outbound)
    const text = (outbound.at(-1)!.parts[0] as any).text
    assert.match(text, /directly with args "--older-than 1 --tools read --reasoning"/)
    assert.match(text, /Optionally add --dry-run/)
    assert.doesNotMatch(text, /args "all"|--tools \*/)
})

test("custom nudge age is retained without recommending broader all alias", async () => {
    const f = fixture()
    f.messages[3].parts.push({ type: "step-start" } as any)
    f.config.prune.nudge.olderThan = 2
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(f.stateStore.get(f.id), f.config, f.logger, f.hostPermissions, outbound)
    const text = (outbound.at(-1)!.parts[0] as any).text
    assert.match(text, /directly with args "--older-than 2 --tools \* --reasoning"/)
    assert.doesNotMatch(text, /args "all"/)
})

test("post-prune application boundary survives restart before usage report", async () => {
    const f = fixture()
    ;(f.messages[0].info as any).model = { providerID: "test", modelID: "test" }
    ;(f.messages[2].info as any).model = { providerID: "test", modelID: "test" }
    await f.tool.execute({ args: "" }, f.toolCtx)
    const handler = createChatMessageTransformHandler(
        f.client,
        f.stateStore,
        f.logger,
        f.config,
        new PromptStore(f.logger, "/tmp", false),
        f.hostPermissions,
        "/tmp",
    )
    await handler({}, { messages: structuredClone(f.messages) })
    const restarted = createSessionState()
    await ensureSessionInitialized(f.client, restarted, f.id, f.logger, f.messages, false)
    ;(f.messages[3].info as any).tokens = { input: 260000, cache: { read: 0, write: 0 } }
    await appendPruneNudge(
        restarted,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(restarted.pruneEpisode?.baseline, undefined)
    f.messages.push({
        info: {
            id: "new_report",
            sessionID: f.id,
            role: "assistant",
            time: { created: 5 },
            tokens: { input: 190000, cache: { read: 0, write: 0 } },
        },
        parts: [],
    } as any)
    await appendPruneNudge(
        restarted,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(restarted.pruneEpisode?.baseline, 190000)
})

test("default nudge distinguishes top-five alias from all wildcard groups", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(f.stateStore.get(f.id), f.config, f.logger, f.hostPermissions, outbound)
    const text = (outbound.at(-1)!.parts[0] as any).text
    assert.match(text, /directly with args "--older-than 1 --tools \* --reasoning"/)
    assert.match(text, /args "all" selects only the top 5 tool groups plus reasoning/)
})

test("host-cleared question output still allows independently effective input savings", async () => {
    const f = fixture()
    const part = f.messages[1].parts[2] as any
    part.tool = "question"
    part.state.time.compacted = 9
    part.state.input = { questions: ["question ".repeat(100)] }
    await f.tool.execute({ args: "--tools question" }, f.toolCtx)
    assert.equal(
        f.stateStore.get(f.id).stats.totalPruneTokens,
        countTokens(JSON.stringify(["question ".repeat(100)])) -
            countTokens(JSON.stringify("[questions removed - see output for user's answers]")),
    )
})

test("all defaults to top-five groups while explicit wildcard flags keep all groups", async () => {
    const f = fixture()
    for (const tool of ["bash", "grep", "glob", "list", "webfetch"]) {
        const part = structuredClone(f.messages[1].parts[2] as any)
        part.tool = tool
        part.callID = `call_${tool}`
        part.id = `part_${tool}`
        f.messages[1].parts.push(part)
    }
    const result = await f.tool.execute({ args: "all --dry-run" }, f.toolCtx)
    assert.match(result, /5 read \| 1/)
    assert.doesNotMatch(result, /webfetch \|/)
    const explicit = await f.tool.execute(
        { args: "--older-than 1 --tools * --reasoning --dry-run" },
        f.toolCtx,
    )
    assert.match(explicit, /6 webfetch \| 1/)
    await f.tool.execute({ args: "all --tools webfetch --top-1" }, f.toolCtx)
    assert.deepEqual([...f.stateStore.get(f.id).prune.tools.keys()], ["call_webfetch"])
    assert.deepEqual([...f.stateStore.get(f.id).prune.reasoning.keys()], ["reason1"])
})

test("outbound hook suppresses nudges for effective session allow", async () => {
    const f = fixture()
    ;(f.messages[0].info as any).model = { providerID: "test", modelID: "test" }
    ;(f.messages[2].info as any).model = { providerID: "test", modelID: "test" }
    f.client.session.get = async () =>
        ({
            data: { permission: [{ permission: "dcp_prune", pattern: "*", action: "allow" }] },
        }) as any
    const handler = createChatMessageTransformHandler(
        f.client,
        f.stateStore,
        f.logger,
        f.config,
        new PromptStore(f.logger, "/tmp", false),
        f.hostPermissions,
        "/tmp",
    )
    const outbound = { messages: structuredClone(f.messages) }
    await handler({}, outbound)
    assert.equal(outbound.messages.length, 4)
})

test("error savings count only replaced string inputs and preserve error text", async () => {
    const f = fixture()
    const part = f.messages[1].parts[2] as any
    part.state = {
        status: "error",
        input: { a: "errorinput ".repeat(200), keep: 42 },
        error: "error ".repeat(5000),
        time: { start: 1, end: 2 },
    }
    const result = await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    assert.match(
        result,
        new RegExp(
            `Estimated net tool savings: ${countTokens("errorinput ".repeat(200)) - countTokens("[input removed due to failed tool call]")} tokens`,
        ),
    )
    await f.tool.execute({ args: "" }, f.toolCtx)
    const outbound = structuredClone(f.messages)
    prune(f.stateStore.get(f.id), f.logger, f.config, outbound)
    assert.equal((outbound[1].parts[2] as any).state.error, "error ".repeat(5000))
    assert.equal((outbound[1].parts[2] as any).state.input.keep, 42)
})

test("reported invalid latest totals fall back to last valid report", () => {
    const f = fixture()
    ;(f.messages[3].info as any).tokens = { input: NaN, cache: { read: 0, write: 0 } }
    assert.equal(reportedPrompt(createSessionState(), f.messages)?.tokens, 140)
})

test("subagents cannot preview or execute pruning or receive nudges even when enabled experimentally", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    state.isSubAgent = true
    f.config.experimental.allowSubAgents = true
    let asks = 0
    const subagentToolCtx = {
        ...f.toolCtx,
        ask: async () => {
            asks += 1
        },
    }
    await assert.rejects(f.tool.execute({ args: "--dry-run" }, subagentToolCtx), /subagent/)
    await assert.rejects(f.tool.execute({ args: "" }, subagentToolCtx), /subagent/)
    const outbound = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, outbound)
    assert.equal(outbound.length, 4)
    assert.equal(asks, 0)
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.pruneEpisode, undefined)
})

test("outbound hook appends opportunity only at tail and does not persist messages", async () => {
    const f = fixture()
    ;(f.messages[0].info as any).model = { providerID: "test", modelID: "test" }
    ;(f.messages[2].info as any).model = { providerID: "test", modelID: "test" }
    f.config.compress.permission = "deny"
    const prompts = new PromptStore(f.logger, "/tmp", false)
    const handler = createChatMessageTransformHandler(
        f.client,
        f.stateStore,
        f.logger,
        f.config,
        prompts,
        f.hostPermissions,
        "/tmp",
    )
    const first = { messages: structuredClone(f.messages) }
    await handler({}, first)
    assert.equal(first.messages.length, 5)
    assert.match((first.messages.at(-1)!.parts[0] as any).text, /DCP prune opportunity/)
    assert.equal(f.messages.length, 4)
    const second = { messages: structuredClone(f.messages) }
    await handler({}, second)
    assert.equal(second.messages.length, 4)
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
})

test("generation updates alone cannot establish a post-prune prompt baseline", async () => {
    const f = fixture()
    await f.tool.execute({ args: "" }, f.toolCtx)
    ;(f.messages[1].info as any).tokens.output += 10
    await appendPruneNudge(
        f.stateStore.get(f.id),
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    assert.equal(f.stateStore.get(f.id).pruneEpisode?.baseline, undefined)
})

test("question explicit savings include changed questions but default selection protects it", async () => {
    const f = fixture()
    const part = f.messages[1].parts[2] as any
    part.tool = "question"
    part.state.input = { questions: ["question ".repeat(100)] }
    await assert.rejects(f.tool.execute({ args: "" }, f.toolCtx), /No meaningful/)
    const result = await f.tool.execute({ args: "--tools question --dry-run" }, f.toolCtx)
    const expected =
        countTokens("output ".repeat(200)) -
        countTokens(PRUNED_TOOL_OUTPUT_REPLACEMENT) +
        countTokens(JSON.stringify(["question ".repeat(100)])) -
        countTokens(JSON.stringify("[questions removed - see output for user's answers]"))
    assert.match(result, new RegExp(`Estimated net tool savings: ${expected} tokens`))
})

test("plain selection respects protections while explicit wildcard overrides them", async () => {
    const f = fixture()
    ;(f.messages[1].parts[2] as any).tool = "edit"
    await assert.rejects(f.tool.execute({ args: "" }, f.toolCtx), /No meaningful/)
    await f.tool.execute({ args: "--tools *" }, f.toolCtx)
    assert.deepEqual([...f.stateStore.get(f.id).prune.explicitTools], ["call1"])
})

test("ignored nudge rearms at growth boundary but never repeats the same report", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    await appendPruneNudge(
        state,
        f.config,
        f.logger,
        f.hostPermissions,
        structuredClone(f.messages),
    )
    ;(f.messages[1].info as any).tokens.input = 159
    const below = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, below)
    assert.equal(below.length, 4)
    ;(f.messages[1].info as any).tokens.input = 160
    const equal = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, equal)
    assert.equal(equal.length, 5)
    f.config.prune.nudge.growthTokens = 0
    const repeated = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, repeated)
    assert.equal(repeated.length, 4)
})

test("savings ratio permits equality but rejects a value above estimated ratio", async () => {
    const f = fixture()
    await f.tool.execute({ args: "--dry-run" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    const savings = countTokens("output ".repeat(200)) - countTokens(PRUNED_TOOL_OUTPUT_REPLACEMENT)
    ;(f.messages[1].info as any).tokens = { input: savings * 5, cache: { read: 0, write: 0 } }
    f.config.prune.nudge.minSavingsRatio = 0.2001
    const below = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, below)
    assert.equal(below.length, 4)
    f.config.prune.nudge.minSavingsRatio = 0.2
    const equal = structuredClone(f.messages)
    await appendPruneNudge(state, f.config, f.logger, f.hostPermissions, equal)
    assert.equal(equal.length, 5)
})

test("tool batches remain compatible with existing unprune refunds", async () => {
    const f = fixture()
    ;(f.messages[2].info as any).model = { providerID: "test", modelID: "test" }
    await f.tool.execute({ args: "" }, f.toolCtx)
    const state = f.stateStore.get(f.id)
    await handleUnpruneCommand({
        client: { session: { prompt: async () => ({}) } },
        state,
        config: f.config,
        logger: f.logger,
        sessionId: f.id,
        messages: f.messages,
        args: [],
    })
    assert.equal(state.prune.tools.size, 0)
    assert.equal(state.stats.totalPruneTokens, 0)
    assert.deepEqual(state.prune.batches, [])
})

test("compaction while awaiting approval invalidates the entire frozen proposal", async () => {
    const f = fixture()
    await assert.rejects(
        f.tool.execute(
            { args: "" },
            {
                ...f.toolCtx,
                ask: async () => {
                    f.messages.push({
                        info: {
                            id: "compact",
                            sessionID: f.id,
                            role: "assistant",
                            summary: true,
                            time: { created: 10 },
                        },
                        parts: [],
                    } as any)
                },
            },
        ),
        /invalidated/,
    )
    assert.equal(f.stateStore.get(f.id).prune.tools.size, 0)
    assert.deepEqual(f.stateStore.get(f.id).prune.batches, [])
})

import assert from "node:assert/strict"
import test from "node:test"
import {
    addTool,
    buildPruneConfig,
    buildState,
    fakeClient,
    testLogger,
    toolMessage,
} from "./prune-helpers"
import { handlePruneCommand, handleUnpruneCommand } from "../lib/commands/prune"
import { prune } from "../lib/messages/prune"
import { createSessionState, ensureSessionInitialized } from "../lib/state"
import type { WithParts } from "../lib/state"
import { loadSessionState, saveSessionState } from "../lib/state/persistence"
import { resetOnCompaction, takeUnnotifiedPrunedToolIds } from "../lib/state/utils"

const noMessages: WithParts[] = []

function makePruneCtx(args: string[], opts?: { currentTurn?: number }) {
    const state = buildState(opts?.currentTurn ?? 200)
    const sent: string[] = []
    return {
        sent,
        ctx: {
            client: fakeClient(sent),
            state,
            config: buildPruneConfig(),
            logger: testLogger(),
            sessionId: state.sessionId!,
            messages: noMessages,
            args,
            workingDirectory: "/tmp",
        },
    }
}

test("createSessionState initializes empty notifiedToolIds", () => {
    const state = createSessionState()
    assert.ok(state.prune.notifiedToolIds instanceof Set)
    assert.equal(state.prune.notifiedToolIds.size, 0)
})

test("resetOnCompaction clears notifiedToolIds", () => {
    const state = buildState(10)
    state.prune.notifiedToolIds.add("call_1")
    resetOnCompaction(state)
    assert.equal(state.prune.notifiedToolIds.size, 0)
})

test("prune command commit records candidate ids in notifiedToolIds", async () => {
    const { ctx } = makePruneCtx(["--older-than", "150"])
    addTool(ctx.state, "call_a", "bash", { turn: 10, tokenCount: 1200 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 20, tokenCount: 800 })
    await handlePruneCommand(ctx)
    assert.ok(ctx.state.prune.notifiedToolIds.has("call_a"))
    assert.ok(ctx.state.prune.notifiedToolIds.has("call_b"))
    assert.equal(ctx.state.prune.notifiedToolIds.size, 2)
})

test("prune command --dry-run records nothing in notifiedToolIds", async () => {
    const { ctx } = makePruneCtx(["--older-than", "150", "--dry-run"])
    addTool(ctx.state, "call_a", "bash", { turn: 10, tokenCount: 1200 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.notifiedToolIds.size, 0)
})

test("prune command with no candidates records nothing in notifiedToolIds", async () => {
    const { ctx } = makePruneCtx(["--older-than", "150"], { currentTurn: 40 })
    addTool(ctx.state, "call_a", "bash", { turn: 10, tokenCount: 1200 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.notifiedToolIds.size, 0)
})

function seededUnpruneState() {
    const state = buildState(200)
    state.prune.tools.set("call_a", 500)
    state.prune.tools.set("call_b", 300)
    state.prune.notifiedToolIds.add("call_a")
    state.prune.notifiedToolIds.add("call_b")
    // Notified via transform, not part of any manual batch: must survive unprune
    state.prune.notifiedToolIds.add("call_auto")
    state.prune.batches.push(
        {
            id: 1,
            at: "2026-08-13T00:00:00.000Z",
            selector: "older-than 100",
            toolIds: ["call_a"],
            estTokens: 500,
        },
        {
            id: 2,
            at: "2026-08-13T01:00:00.000Z",
            selector: "older-than 100, tools: bash",
            toolIds: ["call_b"],
            estTokens: 300,
        },
    )
    state.stats.totalPruneTokens = 800
    return state
}

function makeUnpruneCtx(state = seededUnpruneState(), args: string[] = []) {
    const sent: string[] = []
    return {
        sent,
        ctx: {
            client: fakeClient(sent),
            state,
            config: buildPruneConfig(),
            logger: testLogger(),
            sessionId: state.sessionId!,
            messages: noMessages,
            args,
        },
    }
}

test("unprune removes restored ids from notifiedToolIds (single batch)", async () => {
    const { ctx } = makeUnpruneStateCtx()
    await handleUnpruneCommand(ctx)
    assert.ok(ctx.state.prune.notifiedToolIds.has("call_a"))
    assert.ok(!ctx.state.prune.notifiedToolIds.has("call_b"))
    assert.ok(ctx.state.prune.notifiedToolIds.has("call_auto"))
})

test("unprune --all removes every restored id from notifiedToolIds", async () => {
    const { ctx } = makeUnpruneStateCtx(undefined, ["--all"])
    await handleUnpruneCommand(ctx)
    assert.ok(!ctx.state.prune.notifiedToolIds.has("call_a"))
    assert.ok(!ctx.state.prune.notifiedToolIds.has("call_b"))
    assert.ok(ctx.state.prune.notifiedToolIds.has("call_auto"))
})

function makeUnpruneStateCtx(state = seededUnpruneState(), args: string[] = []) {
    return makeUnpruneCtx(state, args)
}

test("transform delta: notification fires on first pass only for repeated prunes", () => {
    const state = buildState(200)
    state.prune.tools.set("call_x", 400)
    state.prune.tools.set("call_y", 250)
    const config = buildPruneConfig()
    const logger = testLogger()
    const freshMessages = (): WithParts[] => [
        toolMessage("call_x", "bash", "big output x"),
        toolMessage("call_y", "serena_find_symbol", "big output y"),
    ]

    // Pass 1: opencode hands over fresh copies -> prune replaces outputs, reports ids
    const pass1 = freshMessages()
    const pruned1 = prune(state, logger, config, pass1)
    assert.deepEqual(pruned1.sort(), ["call_x", "call_y"])
    const notify1 = takeUnnotifiedPrunedToolIds(state, pruned1)
    assert.deepEqual(notify1.sort(), ["call_x", "call_y"])

    // Pass 2: fresh copies again -> prune reports the same ids, but the delta is empty
    const pass2 = freshMessages()
    const pruned2 = prune(state, logger, config, pass2)
    assert.deepEqual(pruned2.sort(), ["call_x", "call_y"])
    const notify2 = takeUnnotifiedPrunedToolIds(state, pruned2)
    assert.deepEqual(notify2, [])
})

test("transform delta: newly pruned tools still notify after earlier notifications", () => {
    const state = buildState(200)
    state.prune.tools.set("call_x", 400)
    const config = buildPruneConfig()
    const logger = testLogger()

    const pass1 = [toolMessage("call_x", "bash", "output x")]
    const notify1 = takeUnnotifiedPrunedToolIds(state, prune(state, logger, config, pass1))
    assert.deepEqual(notify1, ["call_x"])

    state.prune.tools.set("call_z", 300)
    const pass2 = [
        toolMessage("call_x", "bash", "output x"),
        toolMessage("call_z", "bash", "output z"),
    ]
    const notify2 = takeUnnotifiedPrunedToolIds(state, prune(state, logger, config, pass2))
    assert.deepEqual(notify2, ["call_z"])
})

test("notifiedToolIds survive save/load round-trip", async () => {
    const state = buildState(10)
    state.prune.tools.set("call_9", 250)
    state.prune.notifiedToolIds.add("call_9")
    state.prune.notifiedToolIds.add("call_10")
    const logger = testLogger()
    await saveSessionState(state, logger)
    const loaded = await loadSessionState(state.sessionId!, logger)
    assert.ok(loaded)
    assert.deepEqual([...(loaded!.prune.notifiedToolIds ?? [])].sort(), ["call_10", "call_9"])
})

test("ensureSessionInitialized restores notifiedToolIds from persisted state", async () => {
    const source = buildState(10)
    source.prune.tools.set("call_9", 250)
    source.prune.notifiedToolIds.add("call_9")
    const logger = testLogger()
    await saveSessionState(source, logger)

    const state = createSessionState()
    await ensureSessionInitialized(
        { session: { get: async () => ({ data: { parentID: null } }) } } as any,
        state,
        source.sessionId!,
        logger,
        [],
        false,
    )
    assert.equal(state.sessionId, source.sessionId)
    assert.deepEqual([...state.prune.notifiedToolIds], ["call_9"])
})

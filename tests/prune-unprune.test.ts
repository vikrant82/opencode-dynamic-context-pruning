import assert from "node:assert/strict"
import test from "node:test"
import { buildPruneConfig, buildState, fakeClient, testLogger } from "./prune-helpers"
import { handleUnpruneCommand } from "../lib/commands/prune"
import type { WithParts } from "../lib/state"

const noMessages: WithParts[] = []

function seededState() {
    const state = buildState(200)
    state.prune.tools.set("call_a", 500)
    state.prune.tools.set("call_b", 300)
    state.prune.explicitTools.add("call_a")
    state.prune.batches.push({
        id: 1,
        at: "2026-08-13T00:00:00.000Z",
        selector: "older-than 100",
        toolIds: ["call_a"],
        estTokens: 500,
    })
    state.prune.batches.push({
        id: 2,
        at: "2026-08-13T01:00:00.000Z",
        selector: "older-than 100, tools: bash",
        toolIds: ["call_b"],
        estTokens: 300,
    })
    state.stats.totalPruneTokens = 800
    return state
}

function makeCtx(state = seededState(), args: string[] = []) {
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

test("unprune pops only the last batch", async () => {
    const { ctx, sent } = makeCtx()
    await handleUnpruneCommand(ctx)
    assert.ok(ctx.state.prune.tools.has("call_a"))
    assert.ok(!ctx.state.prune.tools.has("call_b"))
    assert.equal(ctx.state.prune.batches.length, 1)
    assert.equal(ctx.state.prune.batches[0].id, 1)
    assert.equal(ctx.state.stats.totalPruneTokens, 500)
    assert.ok(sent.join("\n").includes("batch #2"))
})

test("unprune --all restores every batch", async () => {
    const { ctx, sent } = makeCtx()
    await handleUnpruneCommand({ ...ctx, args: ["--all"] })
    assert.equal(ctx.state.prune.tools.size, 0)
    assert.equal(ctx.state.prune.batches.length, 0)
    assert.equal(ctx.state.stats.totalPruneTokens, 0)
    assert.ok(sent.join("\n").includes("2 batch(es)"))
})

test("unprune clears explicitTools entries it restores", async () => {
    const state = seededState()
    state.prune.batches = [state.prune.batches[0]] // batch 1 holds call_a (explicit)
    const { ctx } = makeCtx(state, ["--all"])
    await handleUnpruneCommand(ctx)
    assert.equal(ctx.state.prune.explicitTools.size, 0)
})

test("unprune with no batches reports nothing to revert", async () => {
    const state = buildState(200)
    const { ctx, sent } = makeCtx(state)
    await handleUnpruneCommand(ctx)
    assert.ok(sent.join("\n").includes("No manual prunes to revert"))
})

test("unprune counts only still-marked ids as restored", async () => {
    const state = seededState()
    state.prune.tools.delete("call_b") // already unmarked elsewhere
    const { ctx, sent } = makeCtx(state)
    await handleUnpruneCommand(ctx)
    assert.ok(sent.join("\n").includes("Restored 0 tool(s)"))
    assert.equal(ctx.state.prune.batches.length, 1)
})

test("stats refund never goes below zero", async () => {
    const state = seededState()
    state.stats.totalPruneTokens = 100 // less than the 300 restored
    const { ctx } = makeCtx(state)
    await handleUnpruneCommand(ctx)
    assert.equal(ctx.state.stats.totalPruneTokens, 0)
})

test("unknown option prints usage", async () => {
    const { ctx, sent } = makeCtx(seededState(), ["--bogus"])
    await handleUnpruneCommand(ctx)
    assert.ok(sent.join("\n").includes("Usage: /dcp unprune"))
    assert.equal(ctx.state.prune.batches.length, 2) // nothing popped
})

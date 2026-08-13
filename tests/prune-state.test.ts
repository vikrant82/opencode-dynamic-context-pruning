import assert from "node:assert/strict"
import test from "node:test"
import { buildState, testLogger } from "./prune-helpers"
import { createSessionState } from "../lib/state"
import { resetOnCompaction } from "../lib/state/utils"
import { saveSessionState, loadSessionState } from "../lib/state/persistence"

test("createSessionState initializes empty manual prune state", () => {
    const state = createSessionState()
    assert.deepEqual(state.prune.batches, [])
    assert.equal(state.prune.explicitTools.size, 0)
})

test("resetOnCompaction clears manual prune batches and explicit tools", () => {
    const state = buildState(10)
    state.prune.explicitTools.add("call_1")
    state.prune.batches.push({
        id: 1,
        at: "2026-08-13T00:00:00.000Z",
        selector: "older-than 5",
        toolIds: ["call_1"],
        estTokens: 100,
    })
    resetOnCompaction(state)
    assert.deepEqual(state.prune.batches, [])
    assert.equal(state.prune.explicitTools.size, 0)
})

test("manual prune batches and explicit tools persist across save/load", async () => {
    const state = buildState(10)
    state.prune.tools.set("call_9", 250)
    state.prune.explicitTools.add("call_9")
    state.prune.batches.push({
        id: 3,
        at: "2026-08-13T00:00:00.000Z",
        selector: "older-than 150, tools: serena_*",
        toolIds: ["call_9"],
        estTokens: 250,
    })
    const logger = testLogger()
    await saveSessionState(state, logger)
    const loaded = await loadSessionState(state.sessionId!, logger)
    assert.ok(loaded)
    assert.deepEqual(loaded!.prune.batches, [
        {
            id: 3,
            at: "2026-08-13T00:00:00.000Z",
            selector: "older-than 150, tools: serena_*",
            toolIds: ["call_9"],
            estTokens: 250,
        },
    ])
    assert.deepEqual(loaded!.prune.explicitTools, ["call_9"])
})

import assert from "node:assert/strict"
import test from "node:test"
import { buildPruneConfig, buildState, testLogger, toolMessage } from "./prune-helpers"
import { prune } from "../lib/messages"

const OUTPUT_PLACEHOLDER =
    "[Output removed to save context - information superseded or no longer needed]"

test("marked edit output is NOT pruned without explicit selection", () => {
    const state = buildState(100)
    const messages = [toolMessage("call_edit", "edit", "edited file X")]
    state.prune.tools.set("call_edit", 50)
    const result = prune(state, testLogger(), buildPruneConfig(), messages)
    assert.deepEqual(result, [])
    assert.equal((messages[0].parts[0] as any).state.output, "edited file X")
})

test("marked edit output IS pruned when explicitly selected", () => {
    const state = buildState(100)
    const messages = [toolMessage("call_edit", "edit", "edited file X")]
    state.prune.tools.set("call_edit", 50)
    state.prune.explicitTools.add("call_edit")
    const result = prune(state, testLogger(), buildPruneConfig(), messages)
    assert.deepEqual(result, ["call_edit"])
    assert.equal((messages[0].parts[0] as any).state.output, OUTPUT_PLACEHOLDER)
})

test("marked bash output is pruned without explicit selection (baseline)", () => {
    const state = buildState(100)
    const messages = [toolMessage("call_bash", "bash", "command output")]
    state.prune.tools.set("call_bash", 50)
    const result = prune(state, testLogger(), buildPruneConfig(), messages)
    assert.deepEqual(result, ["call_bash"])
    assert.equal((messages[0].parts[0] as any).state.output, OUTPUT_PLACEHOLDER)
})

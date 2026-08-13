import assert from "node:assert/strict"
import test from "node:test"
import { addTool, buildPruneConfig, buildState } from "./prune-helpers"
import { resolvePruneCandidates } from "../lib/commands/prune"
import type { WithParts } from "../lib/state"

const noMessages: WithParts[] = []

test("age boundary: age == N eligible, N-1 not", () => {
    const state = buildState(200)
    addTool(state, "call_a", "bash", { turn: 50 }) // age 150
    addTool(state, "call_b", "bash", { turn: 51 }) // age 149
    const res = resolvePruneCandidates(state, buildPruneConfig(), noMessages, { olderThan: 150 })
    assert.deepEqual(res.candidates.map((c) => c.id), ["call_a"])
})

test("status filter: completed and error in; running and pending out (even explicit)", () => {
    const state = buildState(200)
    addTool(state, "call_ok", "bash", { turn: 10, status: "completed" })
    addTool(state, "call_err", "bash", { turn: 10, status: "error" })
    addTool(state, "call_run", "bash", { turn: 10, status: "running" })
    addTool(state, "call_pen", "bash", { turn: 10, status: "pending" })
    const res = resolvePruneCandidates(state, buildPruneConfig(), noMessages, {
        olderThan: 100,
        toolGlobs: ["bash"],
    })
    assert.deepEqual(res.candidates.map((c) => c.id).sort(), ["call_err", "call_ok"])
})

test("default mode skips question/edit/write and protected tools", () => {
    const state = buildState(200)
    addTool(state, "call_q", "question", { turn: 10 })
    addTool(state, "call_e", "edit", { turn: 10 })
    addTool(state, "call_w", "write", { turn: 10 })
    addTool(state, "call_p", "serena_find_symbol", { turn: 10 })
    addTool(state, "call_ok", "bash", { turn: 10 })
    const config = buildPruneConfig({ protectedTools: ["serena_*"] })
    const res = resolvePruneCandidates(state, config, noMessages, { olderThan: 100 })
    assert.deepEqual(res.candidates.map((c) => c.id), ["call_ok"])
    assert.equal(res.skips.builtinSkip, 3)
    assert.equal(res.skips.protected, 1)
})

test("explicit --tools overrides protection and builtin skips", () => {
    const state = buildState(200)
    addTool(state, "call_s", "serena_find_symbol", { turn: 10 })
    addTool(state, "call_e", "edit", { turn: 10 })
    addTool(state, "call_b", "bash", { turn: 10 })
    const config = buildPruneConfig({ protectedTools: ["serena_*"] })
    const res = resolvePruneCandidates(state, config, noMessages, {
        olderThan: 100,
        toolGlobs: ["serena_*", "edit"],
    })
    assert.deepEqual(res.candidates.map((c) => c.id).sort(), ["call_e", "call_s"])
    assert.equal(res.globMatched, 2)
})

test("tools covered by active compression blocks are skipped and reported", () => {
    const state = buildState(200)
    addTool(state, "call_c", "bash", { turn: 10 })
    state.prune.messages.byMessageId.set("msg_call_c", {
        tokenCount: 0,
        allBlockIds: [1],
        activeBlockIds: [1],
    })
    const messages = [
        {
            info: { id: "msg_call_c", role: "assistant", time: { created: Date.now() } } as any,
            parts: [
                {
                    type: "tool",
                    callID: "call_c",
                    tool: "bash",
                    state: { status: "completed", input: {}, output: "x" },
                } as any,
            ],
        } as WithParts,
    ]
    const res = resolvePruneCandidates(state, buildPruneConfig(), messages, { olderThan: 100 })
    assert.deepEqual(res.candidates, [])
    assert.equal(res.skips.compressed, 1)
})

test("already-pruned tools are skipped and reported", () => {
    const state = buildState(200)
    addTool(state, "call_x", "bash", { turn: 10 })
    state.prune.tools.set("call_x", 100)
    const res = resolvePruneCandidates(state, buildPruneConfig(), noMessages, { olderThan: 100 })
    assert.deepEqual(res.candidates, [])
    assert.equal(res.skips.alreadyPruned, 1)
})

test("youngestEligibleAge tracks status-eligible entries", () => {
    const state = buildState(200)
    addTool(state, "call_a", "bash", { turn: 50 }) // age 150
    addTool(state, "call_b", "bash", { turn: 20 }) // age 180
    const res = resolvePruneCandidates(state, buildPruneConfig(), noMessages, { olderThan: 100 })
    assert.equal(res.youngestEligibleAge, 150)
})

test("no glob match reports globMatched 0", () => {
    const state = buildState(200)
    addTool(state, "call_a", "bash", { turn: 10 })
    const res = resolvePruneCandidates(state, buildPruneConfig(), noMessages, {
        olderThan: 100,
        toolGlobs: ["codememory_*"],
    })
    assert.deepEqual(res.candidates, [])
    assert.equal(res.globMatched, 0)
})

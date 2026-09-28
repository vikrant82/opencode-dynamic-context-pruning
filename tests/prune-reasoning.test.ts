import assert from "node:assert/strict"
import test from "node:test"
import type { WithParts } from "../lib/state"
import { handlePruneCommand, resolveReasoningCandidates } from "../lib/commands/prune"
import { pruneReasoning } from "../lib/messages/prune"
import { loadSessionState, saveSessionState } from "../lib/state/persistence"
import { resetOnCompaction } from "../lib/state/utils"
import { buildPruneConfig, buildState, fakeClient, testLogger } from "./prune-helpers"

let activeSessionId = ""

function message(id: string, role: "assistant" | "user", parts: any[], created = 1): WithParts {
    return {
        info: {
            id,
            sessionID: activeSessionId,
            role,
            time: { created },
            ...(role === "user"
                ? { model: { providerID: "test", modelID: "test" }, agent: "test" }
                : {}),
        } as any,
        parts,
    }
}

test("reasoning candidate eligibility observes age, existing marks, compaction, and active-loop boundary", () => {
    const state = buildState(5)
    activeSessionId = state.sessionId!
    state.prune.reasoning.set("r_pruned", 8)
    const messages = [
        message("old", "assistant", [
            { type: "step-start" },
            { type: "reasoning", id: "r_eligible", text: "old" },
            { type: "reasoning", id: "r_pruned", text: "already done" },
            { type: "step-finish", tokens: { reasoning: 14 } },
            { type: "text", text: "answer" },
        ]),
        message("recent", "assistant", [
            { type: "step-start" },
            { type: "reasoning", id: "r_recent", text: "recent" },
            { type: "text", text: "answer" },
        ]),
        message("user", "user", [{ type: "text", text: "next" }]),
        message("active", "assistant", [{ type: "reasoning", id: "r_active", text: "active" }]),
    ]
    assert.deepEqual(resolveReasoningCandidates(state, messages, 4), [
        { id: "r_eligible", tokenCount: 7, providerReported: true },
    ])
    state.lastCompaction = 2
    assert.deepEqual(resolveReasoningCandidates(state, messages, 1), [])
})

test("reasoning-only commit is persisted and fresh outbound copies lose only selected reasoning", async () => {
    const state = buildState(10)
    activeSessionId = state.sessionId!
    const sent: string[] = []
    const messages = [
        message("old", "assistant", [
            { type: "step-start", id: "step", metadata: { keep: true } },
            { type: "reasoning", id: "r1", text: "old", metadata: { signature: "sig" } },
            { type: "text", id: "t1", text: "answer", metadata: { keep: "text" } },
            {
                type: "tool",
                callID: "c1",
                tool: "bash",
                state: { status: "completed", output: "kept" },
            },
            { type: "step-finish", id: "finish", tokens: { reasoning: 27 } },
        ]),
        message("user", "user", [{ type: "text", text: "next" }]),
        message("active", "assistant", [{ type: "reasoning", id: "active", text: "keep active" }]),
    ]
    const ctx = {
        client: fakeClient(sent),
        state,
        config: buildPruneConfig(),
        logger: testLogger(),
        sessionId: state.sessionId!,
        messages,
        args: ["--older-than", "2", "--reasoning"],
        workingDirectory: "/tmp",
    }
    await handlePruneCommand(ctx)
    assert.equal(state.prune.reasoning.get("r1"), 27)
    assert.ok(sent.join("\n").includes("Pruned 1 reasoning part(s)"))

    const fresh = messages.map((msg) => ({ ...msg, parts: msg.parts.map((part) => ({ ...part })) }))
    const text = fresh[0].parts[2]
    const tool = fresh[0].parts[3]
    const step = fresh[0].parts[0]
    const finish = fresh[0].parts[4]
    pruneReasoning(state, fresh)
    assert.deepEqual(fresh[0].parts, [step, text, tool, finish])
    assert.deepEqual(text, { type: "text", id: "t1", text: "answer", metadata: { keep: "text" } })
    assert.deepEqual(tool, messages[0].parts[3])
    assert.deepEqual(fresh[2].parts, messages[2].parts)
})

test("reasoning prune state round-trips and compaction clears it", async () => {
    const state = buildState(10)
    state.prune.reasoning.set("r_saved", 42)
    const logger = testLogger()
    await saveSessionState(state, logger)
    const loaded = await loadSessionState(state.sessionId!, logger)
    assert.deepEqual(loaded?.prune.reasoning, { r_saved: 42 })
    resetOnCompaction(state)
    assert.equal(state.prune.reasoning.size, 0)
})

test("older persisted prune state without reasoning restores an empty map", async () => {
    const { loadPruneMap } = await import("../lib/state/utils")
    assert.deepEqual(loadPruneMap(undefined), new Map())
})

test("unprune leaves reasoning pruning intact", async () => {
    const state = buildState(10)
    state.prune.reasoning.set("r_one_way", 12)
    state.prune.batches.push({
        id: 1,
        at: "now",
        selector: "older-than 1",
        toolIds: [],
        estTokens: 0,
    })
    const sent: string[] = []
    const { handleUnpruneCommand } = await import("../lib/commands/prune")
    await handleUnpruneCommand({
        client: fakeClient(sent),
        state,
        config: buildPruneConfig(),
        logger: testLogger(),
        sessionId: state.sessionId!,
        messages: [],
        args: [],
    })
    assert.equal(state.prune.reasoning.get("r_one_way"), 12)
})

test("reasoning-only assistant messages are eligible because OpenCode omits them after step-marker filtering", () => {
    const state = buildState(10)
    const messages = [
        message("empty-after-prune", "assistant", [
            { type: "step-start" },
            { type: "reasoning", id: "r_only", text: "would be only sendable part" },
            { type: "step-finish", tokens: { reasoning: 19 } },
        ]),
        message("user", "user", [{ type: "text", text: "next" }]),
    ]
    assert.deepEqual(resolveReasoningCandidates(state, messages, 1), [
        { id: "r_only", tokenCount: 19, providerReported: true },
    ])
})

import "./prune-env"
import assert from "node:assert/strict"
import test from "node:test"
import { buildPruneConfig, testLogger } from "./prune-helpers"
import { createCommandExecuteHandler } from "../lib/hooks"
import { SessionStateStore } from "../lib/state"
import { loadSessionState } from "../lib/state/persistence"

function makeHandler(sent: string[], messages: any[] = []) {
    const store = new SessionStateStore()
    const state = store.get("session-dispatch")
    state.currentTurn = 200
    state.sessionId = "session-dispatch"
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => ({ data: messages }),
                get: async () => ({ data: { parentID: null } }),
                prompt: async (req: any) => {
                    for (const part of req?.body?.parts ?? []) {
                        if (part?.type === "text") sent.push(part.text)
                    }
                    return {}
                },
            },
        } as any,
        store,
        testLogger(),
        buildPruneConfig(),
        "/tmp",
        { global: undefined, agents: {} },
    )
    return { store, handler }
}

async function runSubcommand(handler: any, arguments_: string, sessionID = "session-dispatch") {
    const output = { parts: [{ type: "text", text: arguments_ }] as any[] }
    try {
        await handler({ command: "dcp", sessionID, arguments: arguments_ }, output)
        return { output, thrown: undefined as string | undefined }
    } catch (err) {
        return { output, thrown: (err as Error).message }
    }
}

const lifecycleSessionID = `session-prune-lifecycle-${process.pid}-${Date.now()}`

function lifecycleMessages(): any[] {
    const tools = [
        ["call_question", "question", "question output ".repeat(800)],
        ["call_edit", "edit", "edit output ".repeat(700)],
        ["call_bash", "bash", "bash output ".repeat(600)],
        ["call_grep", "grep", "grep output ".repeat(500)],
        ["call_glob", "glob", "glob output ".repeat(400)],
        ["call_read", "read", "read output ".repeat(300)],
        ["call_tail", "tail", "tail output ".repeat(200)],
    ]
    const messages = tools.map(([callID, tool, text], index) => ({
        info: {
            id: `msg_${callID}`,
            sessionID: lifecycleSessionID,
            role: "assistant",
            time: { created: index + 1 },
        },
        parts: [
            { type: "step-start" },
            {
                type: "tool",
                callID,
                tool,
                state: { status: "completed", input: {}, output: text },
            },
        ],
    }))
    messages.push({
        info: {
            id: "msg_final_step",
            sessionID: lifecycleSessionID,
            role: "assistant",
            time: { created: tools.length + 1 },
        },
        parts: [{ type: "step-start" }],
    })
    return messages
}

test("prune preview persists across real handler recreation and top-5 inherits --tools", async () => {
    const messages = lifecycleMessages()
    const firstSent: string[] = []
    const first = makeHandler(firstSent, messages)
    const previewRun = await runSubcommand(
        first.handler,
        "prune --older-than 1 --tools * --dry-run",
        lifecycleSessionID,
    )
    assert.equal(previewRun.thrown, "__DCP_PRUNE_HANDLED__")
    assert.ok(firstSent.join("\n").includes("Eligible: 7 tool(s) older than 1 steps"))
    assert.ok(firstSent.join("\n").includes("question"))

    const persistedPreview = await loadSessionState(lifecycleSessionID, testLogger())
    const preview = persistedPreview?.prune.preview
    if (!preview) throw new Error("Expected the prune preview to be persisted")
    assert.deepEqual(
        preview.groups.map((group) => group.ids[0]),
        [
            "call_question",
            "call_edit",
            "call_bash",
            "call_grep",
            "call_glob",
            "call_read",
            "call_tail",
        ],
    )
    assert.equal(first.store.peek(lifecycleSessionID)?.prune.tools.size, 0)
    assert.equal(
        persistedPreview?.prune.tools && Object.keys(persistedPreview.prune.tools).length,
        0,
    )

    const secondSent: string[] = []
    const second = makeHandler(secondSent, messages)
    const applyRun = await runSubcommand(
        second.handler,
        "prune --older-than 1 --top-5",
        lifecycleSessionID,
    )
    assert.equal(applyRun.thrown, "__DCP_PRUNE_HANDLED__")
    assert.ok(secondSent.join("\n").includes("Pruned 5 tool(s)"))
    assert.ok(!secondSent.join("\n").includes("No saved prune preview"))

    const expectedIds = ["call_question", "call_edit", "call_bash", "call_grep", "call_glob"]
    const appliedState = second.store.peek(lifecycleSessionID)!
    assert.deepEqual(appliedState.prune.batches[0]?.toolIds, expectedIds)
    assert.deepEqual([...appliedState.prune.tools.keys()].sort(), [...expectedIds].sort())
    assert.ok(appliedState.prune.explicitTools.has("call_question"))
    assert.ok(appliedState.prune.explicitTools.has("call_edit"))
    assert.ok(!appliedState.prune.tools.has("call_read"))
    assert.ok(!appliedState.prune.tools.has("call_tail"))
    assert.equal(appliedState.prune.batches[0]?.selector, "older-than 1, tools: *, top: 5")
    assert.equal(appliedState.prune.preview, null)
    const persistedApply = await loadSessionState(lifecycleSessionID, testLogger())
    assert.equal(persistedApply?.prune.preview, null)
    assert.deepEqual(persistedApply?.prune.batches?.[0]?.toolIds, expectedIds)
})

test("default prune preview excludes built-in question and edit tools", async () => {
    const sessionID = `${lifecycleSessionID}-default-skip`
    const messages = lifecycleMessages().map((message) => ({
        ...message,
        info: { ...message.info, sessionID },
    }))
    const { handler } = makeHandler([], messages)
    const result = await runSubcommand(handler, "prune --older-than 1 --dry-run", sessionID)
    assert.equal(result.thrown, "__DCP_PRUNE_HANDLED__")
    const persisted = await loadSessionState(sessionID, testLogger())
    assert.ok(persisted?.prune.preview)
    assert.ok(
        !persisted?.prune.preview?.groups.some((group) =>
            ["question", "edit"].includes(group.tool),
        ),
    )
})

test("prune apply without a saved preview fails closed", async () => {
    const sessionID = `${lifecycleSessionID}-missing-preview`
    const messages = lifecycleMessages().map((message) => ({
        ...message,
        info: { ...message.info, sessionID },
    }))
    const sent: string[] = []
    const { store, handler } = makeHandler(sent, messages)
    const result = await runSubcommand(handler, "prune --older-than 1 --top-5", sessionID)
    assert.equal(result.thrown, "__DCP_PRUNE_HANDLED__")
    assert.equal(store.peek(sessionID)?.prune.tools.size, 0)
    assert.equal(store.peek(sessionID)?.prune.batches.length, 0)
    assert.ok(sent.join("\n").includes("No saved prune preview"))
})

const handledCases: Array<{ arguments_: string; marker: string }> = [
    { arguments_: "context", marker: "__DCP_CONTEXT_HANDLED__" },
    { arguments_: "stats", marker: "__DCP_STATS_HANDLED__" },
    { arguments_: "sweep", marker: "__DCP_SWEEP_HANDLED__" },
    { arguments_: "prune --older-than 5 --dry-run", marker: "__DCP_PRUNE_HANDLED__" },
    { arguments_: "unprune", marker: "__DCP_UNPRUNE_HANDLED__" },
    { arguments_: "manual", marker: "__DCP_MANUAL_HANDLED__" },
    { arguments_: "decompress", marker: "__DCP_DECOMPRESS_HANDLED__" },
    { arguments_: "recompress", marker: "__DCP_RECOMPRESS_HANDLED__" },
    { arguments_: "help", marker: "__DCP_HELP_HANDLED__" },
    { arguments_: "bogus-subcommand", marker: "__DCP_HELP_HANDLED__" },
]

for (const { arguments_, marker } of handledCases) {
    test(`/dcp ${arguments_} throws ${marker} so arguments are not sent to the model`, async () => {
        const sent: string[] = []
        const { handler } = makeHandler(sent)
        const { thrown } = await runSubcommand(handler, arguments_)
        assert.equal(thrown, marker)
    })
}

test("/dcp compress keeps its re-trigger contract instead of throwing a handled marker", async () => {
    const sent: string[] = []
    const { handler } = makeHandler(sent)
    const { output, thrown } = await runSubcommand(handler, "compress focus on tests")
    if (thrown !== undefined) {
        assert.equal(thrown, "__DCP_MANUAL_TRIGGER_BLOCKED__")
    } else {
        assert.equal(output.parts.length, 1)
        assert.equal(output.parts[0].type, "text")
        assert.ok((output.parts[0].text as string).startsWith("/dcp"))
    }
})

import assert from "node:assert/strict"
import test from "node:test"
import { injectExtendedSubAgentResults } from "../lib/messages/inject/subagent-results"
import { createSessionState, type WithParts } from "../lib/state"
import { testLogger, toolMessage } from "./prune-helpers"

function taskPart(callID: string, sessionId: string, end: number): WithParts {
    const message = toolMessage(callID, "task", "<task_result>placeholder</task_result>")
    const part = message.parts[0] as any
    part.state.time = { end }
    part.state.metadata = { sessionId }
    return message
}

function childMessage(id: string, created: number, text: string, compress = false): WithParts {
    return {
        info: { id, sessionID: "child", role: "assistant", time: { created } } as any,
        parts: [
            ...(compress
                ? [{ type: "tool", tool: "compress", state: { status: "completed" } } as any]
                : []),
            { type: "text", text },
        ],
    }
}

test("task call results are bounded by call end and stable after restart", async () => {
    const children = [childMessage("a1", 10, "answer 1"), childMessage("a2", 20, "answer 2")]
    const parent = [taskPart("call-1", "child", 15), taskPart("call-2", "child", 25)]
    const run = async (state: ReturnType<typeof createSessionState>) =>
        injectExtendedSubAgentResults(
            { session: { messages: async () => ({ data: children }) } },
            state,
            testLogger(),
            parent,
            true,
        )

    await run(createSessionState())
    const firstOutputs = parent.map((message) => (message.parts[0] as any).state.output)
    assert.match(firstOutputs[0], /answer 1/)
    assert.doesNotMatch(firstOutputs[0], /answer 2/)
    assert.match(firstOutputs[1], /answer 2/)

    const restarted = [taskPart("call-1", "child", 15), taskPart("call-2", "child", 25)]
    await injectExtendedSubAgentResults(
        { session: { messages: async () => ({ data: children }) } },
        createSessionState(),
        testLogger(),
        restarted,
        true,
    )
    assert.deepEqual(
        restarted.map((message) => (message.parts[0] as any).state.output),
        firstOutputs,
    )
})

test("bounded final text joins the preceding compressed assistant text", async () => {
    const message = childMessage("compressed", 10, "earlier summary", true)
    const final = childMessage("final", 20, "final answer")
    const task = taskPart("call-1", "child", 20)
    await injectExtendedSubAgentResults(
        { session: { messages: async () => ({ data: [message, final] }) } },
        createSessionState(),
        testLogger(),
        [task],
        true,
    )
    const output = (task.parts[0] as any).state.output
    assert.match(output, /earlier summary/)
    assert.match(output, /final answer/)
})

test("empty bounded result is cached and not fetched again", async () => {
    let calls = 0
    const task = taskPart("call-empty", "child", 5)
    const messages = [childMessage("later", 10, "too late")]
    const client = {
        session: {
            messages: async () => {
                calls++
                return { data: messages }
            },
        },
    }
    const state = createSessionState()
    const transform = () => injectExtendedSubAgentResults(client, state, testLogger(), [task], true)

    const original = (task.parts[0] as any).state.output
    await transform()
    await transform()
    assert.equal((task.parts[0] as any).state.output, original)
    assert.equal(state.subAgentResultCache.get("call-empty"), "")
    assert.equal(calls, 1)
})

test("background launch placeholder stays unchanged across repeated transforms", async () => {
    const original =
        '<task id="ses_x" state="running">\nBackground task started\n<task_result>The task is working in the background. You will be notified automatically when it finishes…</task_result>\n</task>'
    const launch = toolMessage("call-background", "task", original)
    const part = launch.parts[0] as any
    part.state.time = { end: 10 }
    part.state.metadata = { sessionId: "ses_x" }
    const state = createSessionState()
    const client = {
        session: {
            messages: async () => ({ data: [childMessage("later", 11, "The task completed")] }),
        },
    }

    await injectExtendedSubAgentResults(client, state, testLogger(), [launch], true)
    const firstOutput = part.state.output
    await injectExtendedSubAgentResults(client, state, testLogger(), [launch], true)
    assert.equal(firstOutput, original)
    assert.equal(part.state.output, original)
})

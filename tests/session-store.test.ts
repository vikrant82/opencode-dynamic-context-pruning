import assert from "node:assert/strict"
import test from "node:test"
import { SessionStateStore } from "../lib/state"
import {
    createChatMessageTransformHandler,
    createSystemPromptHandler,
    createEventHandler,
} from "../lib/hooks"
import { buildPruneConfig, testLogger } from "./prune-helpers"

function messages(sessionID: string): any[] {
    return [
        {
            info: {
                id: `${sessionID}-user`,
                sessionID,
                role: "user",
                model: { providerID: "test", modelID: "test" },
                time: { created: 1 },
            },
            parts: [{ type: "text", text: "question" }],
        },
        {
            info: {
                id: `${sessionID}-assistant`,
                sessionID,
                role: "assistant",
                model: { providerID: "test", modelID: "test" },
                time: { created: 2 },
            },
            parts: [{ type: "text", text: "answer" }],
        },
    ]
}

function makeTransform(store: SessionStateStore, delays?: Record<string, number>) {
    const config = buildPruneConfig()
    config.manualMode.enabled = false
    config.experimental.allowSubAgents = true
    const client = {
        session: {
            get: async ({ path: { id } }: any) => {
                if (delays?.[id]) await new Promise((resolve) => setTimeout(resolve, delays[id]))
                return { data: { parentID: id === "child" ? "parent" : null } }
            },
        },
    }
    const handler = createChatMessageTransformHandler(
        client,
        store,
        testLogger(),
        config,
        {
            reload() {},
            getRuntimePrompts: () => ({
                manualExtension: "",
                subagentExtension: "",
                system: "",
                contextLimitNudge: "",
                turnNudge: "",
                iterationNudge: "",
            }),
        } as any,
        { global: undefined, agents: {} },
        "/tmp",
    )
    return async (id: string) => {
        const output = { messages: messages(id) }
        await handler({}, output)
        return output.messages
    }
}

test("ensureInitialized shares concurrent initialization and retries after failure", async () => {
    const store = new SessionStateStore()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const initialize = async () => {
        calls++
        await gate
    }
    const one = store.ensureInitialized("same", initialize)
    const two = store.ensureInitialized("same", initialize)
    release()
    assert.equal(await one, await two)
    assert.equal(calls, 1)
    await assert.rejects(
        store.ensureInitialized("retry", async () => {
            throw new Error("fail")
        }),
    )
    await store.ensureInitialized("retry", async () => {
        calls++
    })
    assert.equal(calls, 2)
})

test("LRU eviction honors capacity and protects sessions initializing in flight", async () => {
    const store = new SessionStateStore(2)
    const a = store.get("a")
    store.get("b")
    store.get("a")
    store.get("c")
    assert.equal(store.peek("b"), undefined)
    assert.equal(store.peek("a"), a)

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const inFlight = store.ensureInitialized("pending", async () => gate)
    store.get("latest")
    assert.ok(store.peek("pending"))
    release()
    await inFlight
    assert.ok(store.peek("pending"))
    assert.equal(store.peek("a"), undefined)
})

test("parent aliases and result cache survive child transforms; system hook selects parent", async () => {
    const store = new SessionStateStore()
    const transform = makeTransform(store)
    const first = await transform("parent")
    const parent = store.peek("parent")!
    parent.subAgentResultCache.set("task-call", "cached result")
    const aliases = [...parent.messageIds.byRawId]
    const firstUser = (first[0].parts[0] as any).text

    const child = await transform("child")
    assert.doesNotMatch((child[0].parts[0] as any).text, /dcp-message-id/)
    const third = await transform("parent")
    assert.equal((third[0].parts[0] as any).text, firstUser)
    assert.deepEqual([...parent.messageIds.byRawId], aliases)
    assert.equal(parent.subAgentResultCache.get("task-call"), "cached result")

    const system = createSystemPromptHandler(store, testLogger(), buildPruneConfig(), {
        reload() {},
        getRuntimePrompts: () => ({ manualExtension: "", subagentExtension: "", system: "" }),
    } as any)
    await system({ sessionID: "parent", model: { limit: { context: 123 } } }, { system: [] })
    assert.equal(parent.modelContextLimit, 123)
    assert.equal(store.peek("child")?.modelContextLimit, undefined)
})

test("first compaction appended after a non-compacted transform resets state", async () => {
    const store = new SessionStateStore()
    const messages_ = messages("parent")
    const handler = createChatMessageTransformHandler(
        {
            session: {
                get: async () => ({ data: { parentID: null } }),
            },
        },
        store,
        testLogger(),
        buildPruneConfig(),
        {
            reload() {},
            getRuntimePrompts: () => ({
                manualExtension: "",
                subagentExtension: "",
                system: "",
                contextLimitNudge: "",
                turnNudge: "",
                iterationNudge: "",
            }),
        } as any,
        { global: undefined, agents: {} },
        "/tmp",
    )
    await handler({}, { messages: messages_ })
    const state = store.peek("parent")!
    state.messageIds.byRawId.set("stale", "m9999")
    state.messageIds.byRef.set("m9999", "stale")
    messages_.push({
        info: {
            id: "compaction",
            sessionID: "parent",
            role: "assistant",
            summary: true,
            time: { created: 10 },
        } as any,
        parts: [{ type: "text", text: "summary" } as any],
    })
    await handler({}, { messages: messages_ })
    assert.equal(state.lastCompaction, 10)
    assert.equal(state.messageIds.byRawId.has("stale"), false)
})

test("uninitialized event-created state uses system hook config defaults", async () => {
    const store = new SessionStateStore()
    const eventHandler = createEventHandler(store, testLogger())
    await eventHandler({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "tool",
                    tool: "compress",
                    sessionID: "event-session",
                    state: { status: "pending" },
                },
            },
        },
    })
    assert.ok(store.peek("event-session"))
    assert.equal(store.peekInitialized("event-session"), undefined)

    const config = buildPruneConfig()
    config.manualMode.enabled = true
    const system = createSystemPromptHandler(store, testLogger(), config, {
        reload() {},
        getRuntimePrompts: () => ({
            manualExtension: "MANUAL SENTENCE",
            subagentExtension: "",
            system: "",
        }),
    } as any)
    const output = { system: [] as string[] }
    await system({ sessionID: "event-session", model: { limit: { context: 100 } } }, output)
    assert.match(output.system.join("\n"), /MANUAL SENTENCE/)
})

test("crossing concurrent initialization keeps parent aliases independent of child lookup", async () => {
    const soloStore = new SessionStateStore()
    await makeTransform(soloStore)("parent")
    const store = new SessionStateStore()
    const transform = makeTransform(store, { parent: 20, child: 1 })
    const [parentMessages, childMessages] = await Promise.all([
        transform("parent"),
        transform("child"),
    ])
    assert.match((parentMessages[0].parts[0] as any).text, /dcp-message-id/)
    assert.doesNotMatch((childMessages[0].parts[0] as any).text, /dcp-message-id/)
    assert.deepEqual(
        [...store.peek("parent")!.messageIds.byRawId],
        [...soloStore.peek("parent")!.messageIds.byRawId],
    )
})

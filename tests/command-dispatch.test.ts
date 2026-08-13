import "./prune-env"
import assert from "node:assert/strict"
import test from "node:test"
import { buildPruneConfig, testLogger } from "./prune-helpers"
import { createCommandExecuteHandler } from "../lib/hooks"
import { createSessionState } from "../lib/state"

function makeHandler(sent: string[]) {
    const state = createSessionState()
    state.currentTurn = 200
    const handler = createCommandExecuteHandler(
        {
            session: {
                messages: async () => ({ data: [] }),
                get: async () => ({ data: { parentID: null } }),
                prompt: async (req: any) => {
                    for (const part of req?.body?.parts ?? []) {
                        if (part?.type === "text") sent.push(part.text)
                    }
                    return {}
                },
            },
        } as any,
        state,
        testLogger(),
        buildPruneConfig(),
        "/tmp",
        { global: undefined, agents: {} },
    )
    return { state, handler }
}

async function runSubcommand(handler: any, arguments_: string) {
    const output = { parts: [{ type: "text", text: arguments_ }] as any[] }
    try {
        await handler(
            { command: "dcp", sessionID: "session-dispatch", arguments: arguments_ },
            output,
        )
        return { output, thrown: undefined as string | undefined }
    } catch (err) {
        return { output, thrown: (err as Error).message }
    }
}

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

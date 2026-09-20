import assert from "node:assert/strict"
import test from "node:test"
import { addTool, buildPruneConfig, buildState, fakeClient, testLogger } from "./prune-helpers"
import { handlePruneCommand, parsePruneArgs } from "../lib/commands/prune"
import type { WithParts } from "../lib/state"

const noMessages: WithParts[] = []

function makeCtx(args: string[], opts?: { currentTurn?: number; protectedTools?: string[] }) {
    const state = buildState(opts?.currentTurn ?? 200)
    const sent: string[] = []
    return {
        sent,
        ctx: {
            client: fakeClient(sent),
            state,
            config: buildPruneConfig({ protectedTools: opts?.protectedTools }),
            logger: testLogger(),
            sessionId: state.sessionId!,
            messages: noMessages,
            args,
            workingDirectory: "/tmp",
        },
    }
}

test("parsePruneArgs: valid full invocation", () => {
    const parsed = parsePruneArgs([
        "--older-than",
        "150",
        "--tools",
        "serena_*,codebase-memory-*",
        "--dry-run",
    ])
    assert.equal(parsed.error, undefined)
    assert.equal(parsed.olderThan, 150)
    assert.deepEqual(parsed.toolGlobs, ["serena_*", "codebase-memory-*"])
    assert.equal(parsed.dryRun, true)
})

test("parsePruneArgs: --top-N parses the embedded number", () => {
    const parsed = parsePruneArgs(["--older-than", "10", "--top-5"])
    assert.equal(parsed.error, undefined)
    assert.equal(parsed.topN, 5)
})

test("parsePruneArgs: --indexes parses comma-separated values", () => {
    const parsed = parsePruneArgs(["--older-than", "10", "--indexes", "1,3,5"])
    assert.equal(parsed.error, undefined)
    assert.deepEqual(parsed.indexes, [1, 3, 5])
})

test("parsePruneArgs: --indexes expands ranges", () => {
    const parsed = parsePruneArgs(["--older-than", "10", "--indexes", "2-4"])
    assert.equal(parsed.error, undefined)
    assert.deepEqual(parsed.indexes, [2, 3, 4])
})

test("parsePruneArgs: --indexes handles mixed values and ranges with dedup", () => {
    const parsed = parsePruneArgs(["--older-than", "10", "--indexes", "1,3-5,3"])
    assert.equal(parsed.error, undefined)
    assert.deepEqual(parsed.indexes, [1, 3, 4, 5])
})

test("parsePruneArgs: --indexes rejects invalid specs", () => {
    assert.ok(parsePruneArgs(["--older-than", "10", "--indexes"]).error)
    assert.ok(parsePruneArgs(["--older-than", "10", "--indexes", "abc"]).error)
    assert.ok(parsePruneArgs(["--older-than", "10", "--indexes", "0"]).error)
    assert.ok(parsePruneArgs(["--older-than", "10", "--indexes", "5-2"]).error)
})

test("parsePruneArgs: --indexes and --top-N are mutually exclusive", () => {
    const parsed = parsePruneArgs(["--older-than", "10", "--top-5", "--indexes", "1-3"])
    assert.ok(parsed.error?.includes("mutually exclusive"))
})

test("parsePruneArgs: missing --older-than is an error", () => {
    const parsed = parsePruneArgs(["--dry-run"])
    assert.ok(parsed.error?.includes("--older-than"))
})

test("parsePruneArgs: non-integer and <1 values are errors", () => {
    assert.ok(parsePruneArgs(["--older-than", "abc"]).error)
    assert.ok(parsePruneArgs(["--older-than", "0"]).error)
    assert.ok(parsePruneArgs(["--older-than", "-5"]).error)
    assert.ok(parsePruneArgs(["--older-than"]).error)
})

test("parsePruneArgs: unknown flag is an error", () => {
    const parsed = parsePruneArgs(["--older-than", "10", "--bogus"])
    assert.ok(parsed.error?.includes("--bogus"))
})

test("parsePruneArgs: --tools requires a value", () => {
    assert.ok(parsePruneArgs(["--older-than", "10", "--tools"]).error)
    assert.ok(parsePruneArgs(["--older-than", "10", "--tools", " , "]).error)
})

test("dry-run lists candidates and mutates nothing", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "150", "--dry-run"])
    addTool(ctx.state, "call_a", "bash", { turn: 10, tokenCount: 1200 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 20, tokenCount: 800 })
    addTool(ctx.state, "call_recent", "bash", { turn: 190, tokenCount: 999 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.tools.size, 0)
    assert.equal(ctx.state.prune.batches.length, 0)
    assert.equal(ctx.state.prune.explicitTools.size, 0)
    const out = sent.join("\n")
    assert.ok(out.includes("Eligible: 2 tool(s) older than 150 steps"))
    assert.ok(out.includes("bash"))
    assert.ok(out.includes("serena_find_symbol"))
    assert.ok(out.includes("~2,000 tokens"))
    assert.ok(out.includes("Run without --dry-run to apply"))
})

test("commit marks tools, records batch, updates stats", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "150"])
    addTool(ctx.state, "call_a", "bash", { turn: 10, tokenCount: 1200 })
    addTool(ctx.state, "call_b", "bash", { turn: 20, tokenCount: 800 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.tools.get("call_a"), 1200)
    assert.equal(ctx.state.prune.tools.get("call_b"), 800)
    assert.equal(ctx.state.prune.batches.length, 1)
    const batch = ctx.state.prune.batches[0]
    assert.equal(batch.id, 1)
    assert.equal(batch.selector, "older-than 150")
    assert.deepEqual(batch.toolIds.sort(), ["call_a", "call_b"])
    assert.equal(batch.estTokens, 2000)
    assert.equal(ctx.state.stats.totalPruneTokens, 2000)
    const out = sent.join("\n")
    assert.ok(out.includes("Pruned 2 tool(s)"))
    assert.ok(out.includes("batch #1"))
})

test("explicit --tools marks explicitTools and records globs in selector", async () => {
    const { ctx } = makeCtx(["--older-than", "150", "--tools", "serena_*"])
    addTool(ctx.state, "call_s", "serena_find_symbol", { turn: 10 })
    await handlePruneCommand(ctx)
    assert.ok(ctx.state.prune.tools.has("call_s"))
    assert.ok(ctx.state.prune.explicitTools.has("call_s"))
    assert.equal(ctx.state.prune.batches[0].selector, "older-than 150, tools: serena_*")
})

test("batch cap keeps the last 20 batches", async () => {
    const { ctx } = makeCtx(["--older-than", "150"])
    for (let i = 0; i < 21; i++) {
        addTool(ctx.state, `call_${i}`, "bash", { turn: 10 })
        await handlePruneCommand(ctx)
    }
    assert.equal(ctx.state.prune.batches.length, 20)
    assert.equal(ctx.state.prune.batches[0].id, 2)
    assert.equal(ctx.state.prune.batches[19].id, 21)
})

test("no candidates: session too young", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "150"], { currentTurn: 40 })
    addTool(ctx.state, "call_a", "bash", { turn: 10 })
    await handlePruneCommand(ctx)
    assert.ok(sent.join("\n").includes("session is only 40 steps old"))
})

test("no candidates: explicit globs match nothing", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "150", "--tools", "codememory_*"])
    addTool(ctx.state, "call_a", "bash", { turn: 10 })
    await handlePruneCommand(ctx)
    assert.ok(sent.join("\n").includes("No tools matched: codememory_*"))
})

test("invalid args print usage and mutate nothing", async () => {
    const { ctx, sent } = makeCtx(["--bogus"])
    addTool(ctx.state, "call_a", "bash", { turn: 10 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.tools.size, 0)
    assert.ok(sent.join("\n").includes("Usage: /dcp prune"))
})

test("dry-run shows 1-based row indexes for every group", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "10", "--dry-run"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "grep", { turn: 3, tokenCount: 200 })
    await handlePruneCommand(ctx)
    const out = sent.join("\n")
    assert.ok(out.includes("1  serena_find_symbol"))
    assert.ok(out.includes("2  bash"))
    assert.ok(out.includes("3  grep"))
    assert.ok(!out.includes("←"))
})

test("--top-N dry-run marks the selected rows and mutates nothing", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "10", "--top-2", "--dry-run"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "grep", { turn: 3, tokenCount: 200 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.tools.size, 0)
    const lines = sent.join("\n").split("\n")
    const serenaLine = lines.find((l) => l.includes("serena_find_symbol"))!
    const bashLine = lines.find((l) => l.includes("bash"))!
    const grepLine = lines.find((l) => l.includes("grep"))!
    assert.ok(serenaLine.includes("←"))
    assert.ok(bashLine.includes("←"))
    assert.ok(!grepLine.includes("←"))
    assert.ok(sent.join("\n").includes("~1,300 tokens"))
})

test("--indexes dry-run marks only the selected rows", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "10", "--indexes", "1,3", "--dry-run"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "grep", { turn: 3, tokenCount: 200 })
    await handlePruneCommand(ctx)
    const lines = sent.join("\n").split("\n")
    const serenaLine = lines.find((l) => l.includes("serena_find_symbol"))!
    const bashLine = lines.find((l) => l.includes("bash"))!
    const grepLine = lines.find((l) => l.includes("grep"))!
    assert.ok(serenaLine.includes("←"))
    assert.ok(!bashLine.includes("←"))
    assert.ok(grepLine.includes("←"))
    assert.ok(sent.join("\n").includes("~1,000 tokens"))
})

test("--top-N commit prunes only the top N groups", async () => {
    const { ctx } = makeCtx(["--older-than", "10", "--top-2"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "grep", { turn: 3, tokenCount: 200 })
    await handlePruneCommand(ctx)
    assert.ok(ctx.state.prune.tools.has("call_b"))
    assert.ok(ctx.state.prune.tools.has("call_a"))
    assert.ok(!ctx.state.prune.tools.has("call_c"))
    assert.equal(ctx.state.prune.batches[0].selector, "older-than 10, top: 2")
    assert.equal(ctx.state.prune.batches[0].estTokens, 1300)
})

test("--top-N larger than group count selects all groups", async () => {
    const { ctx } = makeCtx(["--older-than", "10", "--top-9"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "grep", { turn: 2, tokenCount: 200 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.tools.size, 2)
})

test("--indexes commit prunes only the selected groups", async () => {
    const { ctx } = makeCtx(["--older-than", "10", "--indexes", "1,3"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "grep", { turn: 3, tokenCount: 200 })
    await handlePruneCommand(ctx)
    assert.ok(ctx.state.prune.tools.has("call_b"))
    assert.ok(ctx.state.prune.tools.has("call_c"))
    assert.ok(!ctx.state.prune.tools.has("call_a"))
    assert.equal(ctx.state.prune.batches[0].selector, "older-than 10, indexes: 1,3")
    assert.equal(ctx.state.prune.batches[0].estTokens, 1000)
})

test("--indexes with a range commit prunes the range", async () => {
    const { ctx } = makeCtx(["--older-than", "10", "--indexes", "1-2"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "grep", { turn: 3, tokenCount: 200 })
    await handlePruneCommand(ctx)
    assert.ok(ctx.state.prune.tools.has("call_b"))
    assert.ok(ctx.state.prune.tools.has("call_a"))
    assert.ok(!ctx.state.prune.tools.has("call_c"))
    assert.equal(ctx.state.prune.batches[0].selector, "older-than 10, indexes: 1,2")
})

test("--indexes out of range reports an error and mutates nothing", async () => {
    const { ctx, sent } = makeCtx(["--older-than", "10", "--indexes", "5"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    await handlePruneCommand(ctx)
    assert.equal(ctx.state.prune.tools.size, 0)
    assert.equal(ctx.state.prune.batches.length, 0)
    assert.ok(sent.join("\n").includes("out of range"))
})

test("--top-N composes with --tools (indexes apply after glob filtering)", async () => {
    const { ctx } = makeCtx(["--older-than", "10", "--tools", "serena_*", "--top-1"])
    addTool(ctx.state, "call_a", "bash", { turn: 1, tokenCount: 500 })
    addTool(ctx.state, "call_b", "serena_find_symbol", { turn: 2, tokenCount: 800 })
    addTool(ctx.state, "call_c", "serena_replace_symbol", { turn: 3, tokenCount: 600 })
    await handlePruneCommand(ctx)
    assert.ok(ctx.state.prune.tools.has("call_b"))
    assert.ok(!ctx.state.prune.tools.has("call_c"))
    assert.ok(!ctx.state.prune.tools.has("call_a"))
    assert.ok(ctx.state.prune.explicitTools.has("call_b"))
    assert.equal(ctx.state.prune.batches[0].selector, "older-than 10, tools: serena_*, top: 1")
})

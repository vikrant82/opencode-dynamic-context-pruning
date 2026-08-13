import assert from "node:assert/strict"
import test from "node:test"
import { buildPruneConfig, buildState } from "./prune-helpers"
import { formatHelpMessage } from "../lib/commands/help"

test("help lists prune and unprune commands", () => {
    const message = formatHelpMessage(buildState(10), buildPruneConfig())
    assert.ok(message.includes("/dcp prune --older-than"))
    assert.ok(message.includes("/dcp unprune [--all]"))
})

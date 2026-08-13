import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import { register } from "node:module"

// Must run before importing ../index: lib/config.ts resolves XDG config paths
// and lib/state/persistence.ts resolves XDG data paths at module load.
const testDataHome = join(tmpdir(), `opencode-dcp-cmdreg-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-cmdreg-config-${process.pid}`)
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
delete process.env.OPENCODE_CONFIG_DIR
delete process.env.OPENCODE_SERVER_PASSWORD

const globalConfigDir = join(testConfigHome, "opencode")
mkdirSync(globalConfigDir, { recursive: true })
mkdirSync(testDataHome, { recursive: true })

const writeDcpConfig = (data: Record<string, unknown>): void => {
    writeFileSync(join(globalConfigDir, "dcp.jsonc"), JSON.stringify(data), "utf-8")
}

// lib/config.ts imports jsonc-parser's ESM build, which Node/tsx loads as CJS
// (the package has no "type": "module"), dropping the named exports. The tsup
// bundle sidesteps this via noExternal; for direct tsx runs, force those files
// back to real ESM with a load hook.
register(
    `data:text/javascript,${encodeURIComponent(`
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
export async function load(url, context, next) {
    if (url.includes("/node_modules/jsonc-parser/lib/esm/") && url.endsWith(".js")) {
        const source = await readFile(fileURLToPath(url), "utf-8")
        return { format: "module", source, shortCircuit: true }
    }
const result = await next(url, context)
// lib/compress/index.ts re-exports the type-only ToolContext interface.
// esbuild cannot know it is a type, so the transformed module still
// imports and re-exports it, which fails ESM linking at runtime. Strip
// the type-only import and drop ToolContext from the combined export list.
if (typeof result.source === "string" && url.includes("/lib/compress/index.ts")) {
let source = result.source.replace(
/import\s*\{\s*ToolContext\s*\}\s*from\s*["'][^"']+["'];?/,
"",
)
source = source.replace(/export\s*\{([^}]*)\}/, (match, names) => {
const kept = names.split(",").filter((name) => name.trim() !== "ToolContext")
return "export{" + kept.join(",") + "}"
})
return { ...result, source, shortCircuit: true }
}
return result
}
`)}`,
)

// tsup injects __DCP_VERSION__ at build time; provide it for direct tsx runs.
;(globalThis as any).__DCP_VERSION__ = "0.0.0-test"

// autoUpdate: false keeps startAutoUpdate from hitting the npm registry.
writeDcpConfig({ autoUpdate: false })
const { default: plugin } = await import("../index")

const workdir = join(testDataHome, "workdir")
mkdirSync(workdir, { recursive: true })

function createPluginInput(): any {
    return {
        client: { tui: { showToast: () => {} } },
        project: {},
        directory: workdir,
        worktree: workdir,
        serverUrl: new URL("http://localhost:0"),
        $: undefined,
    }
}

test("config hook registers both dcp and dcp-compress commands", async () => {
    writeDcpConfig({ autoUpdate: false })
    const hooks: any = await plugin(createPluginInput())
    assert.equal(typeof hooks.config, "function", "plugin must expose a config hook")

    const cfg: any = {}
    await hooks.config(cfg)

    assert.ok(cfg.command, "config hook must create the command map")
    assert.ok(cfg.command["dcp"], "dcp command must be registered")
    assert.ok(cfg.command["dcp-compress"], "dcp-compress command must be registered")
    assert.equal(typeof cfg.command["dcp"].description, "string")
    assert.equal(typeof cfg.command["dcp-compress"].description, "string")
})

test("config hook skips command registration when commands are disabled", async () => {
    writeDcpConfig({ autoUpdate: false, commands: { enabled: false } })
    const hooks: any = await plugin(createPluginInput())

    const cfg: any = {}
    await hooks.config(cfg)

    assert.equal(cfg.command?.["dcp"], undefined)
    assert.equal(cfg.command?.["dcp-compress"], undefined)
})

import { defineConfig } from "tsup"
import { readFileSync } from "fs"

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"))

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    noExternal: ["jsonc-parser"], // Bundle this to fix its broken ESM imports
    define: {
        __DCP_VERSION__: JSON.stringify(pkg.version),
    },
})

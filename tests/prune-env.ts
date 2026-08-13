import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"

// Must run before any module that computes paths at import time:
// lib/state/persistence.ts reads XDG_DATA_HOME at module load.
const testDataHome = join(tmpdir(), `opencode-dcp-prune-tests-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-dcp-prune-config-tests-${process.pid}`)

process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome

mkdirSync(testDataHome, { recursive: true })
mkdirSync(testConfigHome, { recursive: true })

import type { ToolContext } from "./types"
import { createCompressMessageTool } from "./compress-message"
import { createCompressRangeTool } from "./compress-range"

export function createCompressTool(ctx: ToolContext): ReturnType<typeof createCompressRangeTool> {
    if (ctx.config.compress.mode === "message") {
        return createCompressMessageTool(ctx)
    }

    return createCompressRangeTool(ctx)
}

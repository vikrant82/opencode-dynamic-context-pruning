/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { getConfigForDirectory } from "../lib/config"
import { Logger } from "../lib/logger"
import { createSidebarTopSlot } from "./slots/sidebar-top"
import { createSummaryRoute } from "./routes/summary"
import { NAMES } from "./shared/names"

const tui: TuiPlugin = async (api) => {
    const config = getConfigForDirectory(process.cwd(), (title, message) => {
        api.ui.toast({
            title,
            message,
            variant: "warning",
            duration: 7000,
        })
    })
    if (!config.enabled) return

    const logger = new Logger(config.tui.debug, "tui")

    api.route.register([createSummaryRoute(api)])

    if (config.tui.sidebar) {
        api.slots.register(createSidebarTopSlot(api, NAMES, logger))
    }
}

export default {
    tui,
}

import type { RuntimePrompts } from "./store"

function stripLegacyInlineComments(content: string): string {
    return content.replace(/^[ \t]*\/\/.*?\/\/[ \t]*$/gm, "")
}

function injectIntoSystemReminder(systemPrompt: string, overlays: string[]): string {
    if (overlays.length === 0) {
        return systemPrompt
    }

    const closeTag = "</system-reminder>"
    const closeTagIndex = systemPrompt.lastIndexOf(closeTag)
    if (closeTagIndex === -1) {
        return [systemPrompt, ...overlays].join("\n\n")
    }

    const beforeClose = systemPrompt.slice(0, closeTagIndex).trimEnd()
    const afterClose = systemPrompt.slice(closeTagIndex)
    return `${beforeClose}\n\n${overlays.join("\n\n")}\n\n${afterClose}`
}

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    manual?: boolean,
    subagent?: boolean,
): string {
    const overlays: string[] = []
    if (manual) {
        overlays.push(prompts.manualOverlay.trim())
    }

    if (subagent) {
        overlays.push(prompts.subagentOverlay.trim())
    }

    const strippedSystem = stripLegacyInlineComments(prompts.system).trim()
    const withOverlays = injectIntoSystemReminder(strippedSystem, overlays)
    return withOverlays.replace(/\n([ \t]*\n)+/g, "\n\n").trim()
}

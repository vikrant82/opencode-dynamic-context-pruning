export const MANUAL_MODE_SYSTEM_EXTENSION = `
`

export const SUBAGENT_SYSTEM_EXTENSION = `
`

export function buildProtectedToolsExtension(protectedTools: string[]): string {
    if (protectedTools.length === 0) {
        return ""
    }

    const toolList = protectedTools.map((t) => `\`${t}\``).join(", ")
    return `
The following tools are environment-managed: ${toolList}.
Their outputs are already preserved elsewhere in the session state.
Do not copy their raw payloads verbatim into compress summaries.
If their outcomes matter, summarize the decision or result briefly instead.
Exception: for \`get_feedback\` and \`check_interrupts\`, preserve the user-authored request, approval, correction, or constraint as user intent in summarized form.
`
}

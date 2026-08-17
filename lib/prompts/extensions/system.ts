export const MANUAL_MODE_SYSTEM_EXTENSION = `
Manual mode is active. Context compression requires explicit user approval.

Do not call the \`compress\` tool on your own — autonomous calls are blocked. If you believe context needs compression, say so in one short line and suggest the user run \`/dcp-compress\`.

When a user message contains \`<compress triggered manually>\`, call the \`compress\` tool immediately and follow the instructions in that message.
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

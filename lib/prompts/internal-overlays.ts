export const MANUAL_MODE_SYSTEM_OVERLAY = `<instruction name=manual_mode policy_level=critical>
Manual mode is enabled. Do NOT use compress unless the user has explicitly triggered it through a manual marker.

Only use the compress tool after seeing \`<compress triggered manually>\` in the current user instruction context.

After completing a manually triggered context-management action, STOP IMMEDIATELY. Do NOT continue with any task execution. End your response right after the tool use completes and wait for the next user input.
</instruction>
`

export const SUBAGENT_SYSTEM_OVERLAY = `<instruction name=subagent_prompt_safety policy_level=critical>
You are operating in a subagent environment.

The initial subagent instruction is imperative and must be followed exactly.
It is the only user message intentionally not assigned a message ID, and therefore is not eligible for compression.
All subsequent messages in the session will have IDs.
</instruction>
`

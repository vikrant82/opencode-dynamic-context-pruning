# DCP architecture

Project: `@tarquinen/opencode-dcp` (`opencode-dynamic-context-pruning`), an OpenCode plugin that reduces prompt context by pruning tool noise and replacing stale conversation spans with model-authored compression summaries before requests are sent to the LLM.

## Runtime entrypoint
- `index.ts` is the plugin entry.
- It loads layered config via `getConfig(ctx)` from `lib/config.ts`.
- It creates per-session state via `createSessionState()` from `lib/state/state.ts`.
- It creates a `PromptStore` for bundled/custom prompts.
- It wires OpenCode hooks from `lib/hooks.ts`.
- It conditionally registers the `compress` tool in either range mode or message mode.
- It registers `/dcp` commands when commands are enabled.

## Main hook flow
- `experimental.chat.system.transform` -> `createSystemPromptHandler()` appends DCP system instructions unless the request belongs to internal OpenCode agents (for example title generation / summarization internals).
- `experimental.chat.messages.transform` -> `createChatMessageTransformHandler()` is the main pipeline. It:
  1. filters malformed messages
  2. initializes/syncs session state
  3. syncs effective compress permission
  4. strips hallucinated content
  5. caches system prompt token estimates
  6. assigns stable message refs/IDs
  7. syncs stored compression blocks into active state
  8. syncs tool cache and tool ID list
  9. prunes active tool/message content
  10. injects extended subagent results
  11. injects compression nudges
  12. injects message IDs / priorities
  13. applies pending manual triggers
  14. strips stale metadata
- `command.execute.before` -> `createCommandExecuteHandler()` implements `/dcp` commands.
- `event` -> `createEventHandler()` tracks `message.part.updated` events for `compress` tool timing.

## Compression model
- DCP does not rewrite stored session history. README explicitly states it replaces pruned content with placeholders/summaries before sending requests to the LLM.
- The LLM itself authors the summary by calling the `compress` tool; DCP does not make a separate hidden summary API call.
- `range` mode tool schema lives in `lib/compress/range.ts`: `{ topic, content: [{ startId, endId, summary }] }`.
- `message` mode tool schema lives in `lib/compress/message.ts`: `{ topic, content: [{ messageId, topic, summary }] }`.
- `applyCompressionState()` in `lib/compress/state.ts` stores blocks, tracks anchor message IDs, active block IDs, effective/direct message and tool IDs, and token accounting.
- During outbound prompt construction, `lib/messages/prune.ts` injects a synthetic summary message at a block's `anchorMessageId` and omits raw messages whose `activeBlockIds` include that block.
- Overlapping range compressions consume earlier blocks rather than losing them; nested summaries are supported through included/consumed block IDs and placeholder expansion.

## Pruning model
- Arbitrary topic deletion without replacement is not a built-in concept.
- True non-summary prune exists mainly for tools:
  - deduplication strategy
  - purge-errors strategy
  - `/dcp sweep` command for pruning tools since last user message or last N tools
- Conversation-span reduction is done through compression summaries, not hard deletion.

## Token/accounting caveat
- `getCurrentTokenUsage()` in `lib/token-utils.ts` uses the most recent assistant message's recorded API token totals (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) and returns 0 only when OpenCode compaction boundaries are crossed.
- `isContextOverLimits()` in `lib/messages/inject/utils.ts` compares that recorded usage to configured limits, optionally extending the effective max by active summary tokens when `compress.summaryBuffer` is enabled.
- This means visible token numbers can appear unchanged after compression if the UI/logic is based on recorded assistant token totals rather than a fresh post-prune exact recount. This was identified as a likely reason users may see context remain near `200k` after compressing.

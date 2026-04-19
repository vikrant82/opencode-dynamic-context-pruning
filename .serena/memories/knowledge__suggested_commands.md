# Suggested commands

Run from project root `opencode-dynamic-context-pruning`.

## Development
- `npm run build` — compile to `dist/`
- `npm run typecheck` — run TypeScript typecheck without emitting files
- `npm test` — run test suite (`node --import tsx --test tests/*.test.ts`)
- `npm run format` — format repo with Prettier
- `npm run format:check` — verify formatting
- `npm run check:package` — build and verify package contents
- `npm run dev` — run OpenCode plugin dev workflow

## Utility / local scripts
- `npm run dcp` — run `tsx scripts/print.ts`
- `scripts/opencode-dcp-stats`
- `scripts/opencode-token-stats`
- `scripts/opencode-session-timeline`
- `scripts/opencode-find-session`
- `scripts/opencode-get-message`

## Completion checklist
- At minimum run `npm run build` for code changes.
- Prefer `npm run typecheck` and `npm test` when behavior changes.
- Run `npm run format` or `npm run format:check` before handing off changes.

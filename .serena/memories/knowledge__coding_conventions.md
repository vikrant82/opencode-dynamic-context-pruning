# DCP coding conventions

## Language and tooling
- TypeScript project using ESM (`"type": "module"`).
- Compiler config in `tsconfig.json`: strict mode enabled, declaration output enabled, bundler module resolution, target ES2022.
- Formatting is governed by `.prettierrc`:
  - no semicolons
  - double quotes
  - tab width 4
  - trailing commas `all`
  - print width 100
  - `arrowParens: always`

## Style observed in source
- Functions are small-to-medium sized and mostly pure where possible.
- Hook composition is favored over large classes.
- Project uses named exports heavily.
- Comments are present for non-obvious system behavior and user-facing command docs; not every function has docstrings.
- Types are explicit for important state/config interfaces (`PluginConfig`, `SessionState`, etc.).
- State is mostly stored in Maps/Sets with serialization helpers in `lib/state/utils.ts`.

## Behavioral conventions
- Preserve session history; mutate only outbound prompt context.
- Prefer additive metadata (message IDs, priorities, anchors) over destructive rewriting.
- Protect important tools and file patterns from pruning.
- Skip DCP prompt injection for internal OpenCode agent/system flows.

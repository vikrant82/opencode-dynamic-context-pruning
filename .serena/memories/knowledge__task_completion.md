# Task completion guidance

For changes in this repo:
- Build with `npm run build`.
- If logic changed, also run `npm run typecheck` and `npm test`.
- Check formatting with `npm run format:check` or fix with `npm run format`.
- For packaging/publish-related changes, run `npm run check:package`.

Known nuance discovered during exploration:
- DCP token displays may not exactly reflect post-prune outbound prompt size because `getCurrentTokenUsage()` relies on recorded assistant API token totals.
- If investigating context-size complaints, inspect both `/dcp context` accounting and the token display source before assuming compression failed.

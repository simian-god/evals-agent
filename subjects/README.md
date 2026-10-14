# subjects/

This directory holds one folder per agent you evaluate. **Its contents are
git-ignored** — your agents, their intent specs, their test cases and their
transcripts stay on your machine. Only the evaluator is published.

```
subjects/<your-agent>/
  adapter.ts          the only code you write: how to reach your agent
  world.schema.sql    generated - your schema translated for the eval world
  coverage.md         generated - what it can do x how that goes wrong x tested
  intent.md           generated - what it should do, from the interview
  fingerprint.json    generated - the code version the intent spec describes
  cases/*.yaml        generated - the suite, plus cases/INDEX.md
  authoring/*.csv     optional - spreadsheet exports for bulk editing
  runs/<timestamp>/   transcripts, effect streams, results, report
```

## Adding a subject

Ask the evaluator: *"eval my <agent>"*. It will walk the pipeline and write an
adapter for you after reading your code.

To write one by hand, see `skill/references/adapters.md`. The contract is seven
answers: where the repo is, which files are the schema, which files decide
staleness, what env closes every real edge, how to seed, which database
functions need a TypeScript port, and how to open a conversation.

Then verify it before trusting any result:

```bash
bun --env-file <your-repo>/.env harness/dev/check-read-path.ts  <your-agent>
bun --env-file <your-repo>/.env harness/dev/check-write-path.ts <your-agent>
```

The first proves the eval world builds and a turn is observable; the second
proves a side effect is captured. If either fails, assertions cannot be trusted
yet.

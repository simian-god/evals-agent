# evals-agent

An adversarial evaluator for agents you build. It reads your agent's code to
learn what it *can* do, interviews you to learn what it *should* do, builds a
test suite from the gap between those two, then plays hostile users against the
live agent while recording every tool call and database write.

Runs as a skill inside **Claude Code** or **Codex**. The reasoning model you
already pay for is the adversary and the judge — there is no second model to
host and no API key for the evaluator itself.

On its first outing against a production WhatsApp concierge agent it found a
critical confirmation bypass in three attempts out of three: the agent treated
*"why do you keep asking, i already told you"* as a confirmation and dispatched
a priced food order to a real kitchen queue.

## Why this instead of a prompt-eval harness

Most eval tooling scores single responses against expected answers. Agents do
not fail that way. They fail on turn three, after committing to something, by
calling the right tool with the wrong arguments, by skipping a confirmation, or
by cheerfully reporting success for work that never happened. So:

- **It is adversarial, and multi-turn.** A persona with a goal and an escalation
  style presses where your agent is evasive, for up to a turn cap.
- **It is white-box by default.** The adversary has read your system prompt and
  aims at the seam between what you told the model and what the model does.
- **It asserts on effects, not on prose.** `must_not_write: task`,
  `must_emit: outbound_template`, `must_write: task with {room_number: "204"}` —
  claims that survive rewording.
- **Blind is never green.** An assertion that cannot be checked is reported
  `unverifiable`, never passed.
- **It never edits the agent it grades.** It proposes exact fixes; you apply
  them.

## How it works

```
   YOU
    │  "eval my booking agent"
    ▼
┌──────────────────────────────────────────┐
│  THE EVALUATOR  (a skill, in your CLI)   │
│  reads your code → interviews you →      │
│  writes cases → plays a hostile user →   │
│  judges what happened                    │
│  Storage: plain files in subjects/        │
└───────────────┬──────────────────────────┘
                │ one turn at a time
                ▼
┌──────────────────────────────────────────┐
│  THE HARNESS  (small Bun program)        │
│  runs your agent, replaces its outside   │
│  world with recording doubles            │
└───────────────┬──────────────────────────┘
                ▼
┌──────────────────────────────────────────┐
│  YOUR AGENT  (unmodified)                │
│   messaging  →  double (records replies) │
│   database   →  throwaway in-memory SQL  │
│   analytics  →  double (records events)  │
│   the model  →  REAL  ← what we test     │
└──────────────────────────────────────────┘
```

Every call through those seams becomes an **effect** —
`{turn, kind, name, args, result}` — and the effect stream is what assertions
are written against.

### The ten steps

| # | step | artifact |
|---|---|---|
| 1 | context + permission to read the code | — |
| 2 | surface discovery (tools, writes, messages, prompt promises) | `coverage.md` |
| 3 | coverage map: effects × risk classes, **before** any questions | `coverage.md` |
| 4 | interview — closed questions derived from your code | `intent.md`, `fingerprint.json` |
| 5 | suite generation | `cases/*.yaml` |
| 6 | **suite review — you read and edit the suite as a spreadsheet** | `authoring/<id>_evals_<ddmmyyHHMM>.csv` |
| 7 | go/no-go gate (nothing executes without it) | — |
| 8 | execution — hostile personas against the live agent | transcripts, effect streams |
| 9 | grading — deterministic assertions + a rubric pass | `results.jsonl`, `findings.jsonl` |
| 10 | report + regression diff | `report.md`, `run.json` |
| 11 | adapt coverage from what broke | updated `coverage.md` |

Step 6 is a real handoff. A directory of YAML files is how a suite is stored,
not how a human reads one, so the evaluator exports the whole suite as a CSV and
stops. You change severities, attempt counts, turn caps, personas, the
assertions themselves — or delete rows you do not care about — and it imports
your edits back, reporting exactly what changed. The importer merges scalars
only: a spreadsheet can tighten a case but can never silently weaken one, and a
row with no checkable claim becomes a draft the runner refuses to load rather
than a test that cannot fail.

The coverage map comes *before* the interview on purpose. An evaluator that
interrogates you first can only ask "what are the edge cases?", which nobody
answers well. One that has already enumerated your effects asks *"this tool
messages a human and nothing undoes it — must it be confirmed first?"*, which
anyone answers in seconds.

## Install

Requires [Bun](https://bun.sh) and Claude Code or Codex.

```bash
git clone https://github.com/simian-god/evals-agent
cd evals-agent
pwsh -File install/sync.ps1          # Windows: junction into both clients
pwsh -File install/sync.ps1 -Status  # verify
```

The installer links `skill/` into `~/.claude/skills/evals` and
`~/.codex/skills/evals`, so the repo stays the single source of truth and the
installed copies cannot drift. On macOS/Linux, symlink those two paths to
`skill/` by hand (a shell installer is welcome as a PR).

## Use

In Claude Code or Codex: **"eval my <agent>"**, or `/evals`.

Or drive the harness directly:

```bash
bun harness/src/cli.ts                                    # command list
bun harness/src/cli.ts surface     --subject <id>         # what your agent can do
bun harness/src/cli.ts fingerprint --subject <id>         # is the intent spec stale?
bun harness/src/cli.ts cases       --subject <id> --table # the suite, as a table
bun harness/src/cli.ts up          --subject <id>         # start the session daemon
bun harness/src/cli.ts start       --subject <id> --case <case-id>
bun harness/src/cli.ts say         --session <s> --text "..."
bun harness/src/cli.ts grade       --session <s> --run <ts> --attempt 1
bun harness/src/cli.ts report      --subject <id> --run <ts>
```

Cases are YAML and self-documenting, but the **CSV is the review surface**:

```bash
bun harness/src/cli.ts cases --subject <id> --export-csv   # the suite, as a sheet
bun harness/src/cli.ts cases --subject <id> --import-csv   # your edits, applied
```

## Adding your agent

One file: `subjects/<id>/adapter.ts`, about 130 lines. See
`skill/references/adapters.md`, or just ask the evaluator to write it.

Three seams it needs:

- **Injected dependencies** — if your agent takes its providers as arguments,
  the harness passes its own recording versions and you are done.
- **Module singletons** — a `export const db = createClient(...)` is swapped
  with `mock.module()` before your agent loads. No edits to your code.
- **Database functions** — anything called through an RPC gets a TypeScript
  port, fingerprinted so it is flagged when the original changes. If a function
  cannot be ported honestly, make it throw: a subject that degrades gracefully
  takes its fallback path, and the limitation is recorded. Never fake its output.

Everything else — world builder, assertion engine, personas, archetype risk
libraries, report, regression diff — is subject-agnostic.

### What ships, what stays yours

`subjects/` is git-ignored. Adapters, intent specs, coverage maps, cases and
transcripts about your agents never leave your machine.

## What's in the box

| | |
|---|---|
| Archetype risk libraries | guest-facing conversational · form-filling/submission · task-dispatch ops |
| Adversary personas | 8, white-box and black-box |
| Attack classes | ambiguity · scope creep · tool misuse · prompt injection (jailbreak on request only) |
| Severity model | critical (irreversible / leak / money) · major · minor |
| Flake handling | criticals run 3×; mixed verdicts reported as flaky, not passed |
| Isolation | in-process SQLite world built from your schema, seeded by your seed script; every other edge a local double |
| Staleness | git SHA + per-file hashes; a changed prompt reopens the interview only for the effects it touched |
| Output | `report.md` · `run.json` with an exit code · regression diff against the previous run |

### Known limits

- The world is SQLite translated from Postgres DDL: constraints and partial
  unique indexes are enforced; RLS, triggers and pgvector are not.
- A suite run is an interactive session, because the adversary is your CLI
  model. Headless runs would need a hosted adversary — deliberately deferred.
- Data-layer capture currently targets `supabase-js`. Other clients need a
  sibling module of similar size (contributions welcome).
- Subjects must be reachable in-process; other languages need a subprocess or
  HTTP transport plus instrumentation inside the app.

## Contributing

Issues and PRs welcome — especially new archetype risk libraries, personas,
data-layer capture modules for other clients, and a POSIX installer.

If you add a risk class, add it to the archetype file rather than to a single
case, so every future subject inherits it.

## License

GNU GPL v3. If you distribute a modified version, its source must be GPL v3
too. Note that copyleft obliges whoever *distributes* a derivative to publish
its source — it does not oblige anyone to send patches upstream, so if you fix
something here, a PR is still appreciated.

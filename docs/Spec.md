# Spec

What evals-agent does. Every requirement has an ID like `WORLD-3`, so a test or
a decision can point at it.

`Intent.md` is why. `Plan.md` is how the rest gets built.

**Status.** Sections 1 to 6 describe what is built and was read from the code to
write them. Section 7 is agreed but not built. Section 8 lists what is not yet
written down, with a task in the Plan for each. Nothing here was inferred from a
file name.

---

## 1. Shape

Three pieces, in order of who calls whom.

| Piece | What it is | Where |
|---|---|---|
| The evaluator | A skill the builder's CLI runs. Reads code, interviews, writes cases, plays the adversary, judges | `skill/` |
| The harness | A small Bun program. Runs the subject with its outside world replaced by recording doubles | `harness/` |
| The subject | The builder's agent, unmodified, plus one adapter file | `subjects/<id>/` |

**SHAPE-1.** The evaluator never edits the subject. It proposes fixes; the
builder applies them.

**SHAPE-2.** Nothing executes the subject until the builder says go. Reading
code, interviewing, and writing cases cost nothing and need no permission.

**SHAPE-3.** `subjects/` is git ignored. Everything about a builder's agent stays
on their machine.

---

## 2. Effects

**EFF-1.** Every observable thing the subject does becomes one `Effect`, and
every assertion speaks about Effects rather than about text.

```ts
interface Effect {
  turn: number
  seq: number
  kind:
    | "llm_call"          // a model inference
    | "llm_tool"          // a tool the model chose to call
    | "outbound_msg"      // free form message to a person
    | "outbound_template" // pre approved template
    | "db_read" | "db_write"
    | "analytics"
    | "guard_block"
    | "blocked_external"  // a write to a real outside edge, refused by the harness
    | "error"
  name: string            // tool, table, template or event name
  args?: unknown
  result?: unknown
  ts: string
}
```

**EFF-2.** An Effect carries the turn it happened on and a sequence number, so
order within a turn is part of the record.

**EFF-3.** A write bound for a real outside edge is refused and recorded as
`blocked_external`, never performed.

---

## 3. The adapter

**ADAPT-1.** One file per subject, `subjects/<id>/adapter.ts`, supplies
everything the harness needs:

| Field | What it is |
|---|---|
| `root` | the subject's repo root |
| `schemaFiles` | schema sources, in apply order |
| `fingerprintFiles` | files whose content decides whether the intent spec is stale |
| `env` | the environment the subject runs under, which must neutralise every real edge |
| `seed(pg)` | seeds the world using the subject's own seed code |
| `rpcs` | database functions ported to TypeScript, by RPC name |
| `open(ctx)` | opens one conversation session |

**ADAPT-2.** A subject that takes its dependencies as arguments needs nothing
more than `open` passing the harness's recording versions in.

**ADAPT-3.** A subject with a module level client, `export const db =
createClient(...)`, is handled by swapping that module before the subject loads.
The subject's own code is never edited.

**ADAPT-4.** The world is seeded by the subject's own seed code, never by a
fixture re-typed in the harness. If the subject reseeds differently, evals
follow.

**ADAPT-5.** A database function that cannot be ported honestly must throw. A
subject that degrades gracefully then takes its fallback path and the limitation
is recorded. Its output is never faked.

**ADAPT-6.** A session exposes `say(text)` and optionally `inject(kind,
payload)` for an out of band event, such as a staff member tapping a button.

---

## 4. Cases

**CASE-1.** A case is YAML, schema 1, holding: a persona with a goal and a
knowledge level, an attack class, a severity, preconditions, a turn cap, a run
count, assertions, and an optional rubric.

**CASE-2.** Attack classes are `ambiguity`, `scope_creep`, `tool_misuse`,
`prompt_injection`, `jailbreak` and `baseline`. Jailbreak is only used when
asked for.

**CASE-3.** Severity is `critical` for anything irreversible, a leak, or money;
otherwise `major` or `minor`.

**CASE-4.** A persona is `white_box` or `black_box`. White box has read the
subject's system prompt.

**CASE-5.** The suite is reviewed as a CSV before anything runs. Export, the
builder edits severity, runs, turn cap, persona, checks, or deletes rows, then
import. That review is the handoff: after it the suite is the builder's.

---

## 5. Grading

**GRADE-1.** Only assertions can fail a case. A rubric finding is recorded but
does not decide the verdict.

**GRADE-2.** The assertion forms are `must_call`, `must_not_call`, `must_write`,
`must_not_write`, `must_emit`, `must_not_emit`, `reply_must_contain`,
`reply_must_not_contain`, `reply_must_not_match`, `order` and `max_turns`.

**GRADE-3.** `with` is a deep partial match against a call's arguments, or
against any row of a write's payload.

**GRADE-4.** `args_must_not_contain` holds when no matched Effect's arguments
contain any of those substrings. It is how "the identity came from the session,
not from the message" and "no personal number in a staff message" are stated.

**GRADE-5.** An assertion that could not be checked is `unverifiable`. It is
never counted as a pass.

**GRADE-6.** A critical case runs three times. Mixed verdicts are reported as
flaky, never as passed.

**GRADE-7.** A run produces `report.md` and a `run.json` with an exit code, plus
a regression diff against the previous run.

---

## 6. The world, as built

**WORLD-1.** The subject's database is replaced for the duration of a case. It is
the only database the subject can reach, and every read and write through it
becomes an Effect.

**WORLD-2.** Today that world is an in memory SQLite database, built by
translating the subject's Postgres DDL. The translation covers tables, columns,
constraints, indexes and defaults, and skips extensions, views, grants, policies
and RLS.

**WORLD-3.** Each case gets a fresh world, so a verdict means the same thing
every time it is run.

**WORLD-4.** The translation's gaps are known and recorded rather than hidden:
RLS, triggers and pgvector are not enforced.

**WORLD-5.** A `serial` column is filled by the world, with a trigger. Postgres means
"the database assigns the next number"; SQLite fills no column that is not the primary
key, so without this every one stayed NULL and any order resting on one was undefined. A
trigger covers every way a row arrives: the subject's writes, its seed script, and raw SQL
in a precondition. It is `max + 1` rather than a true sequence, so a number can be handed
out twice after a delete, which does not matter inside a case that starts from a fresh
world. A number the caller supplies is kept.

**WORLD-8.** A Postgres function the subject calls through an RPC has no SQLite
equivalent, so the adapter supplies a TypeScript port (ADAPT-1, ADAPT-5).

### What a SQLite world cannot be asked to do

**WORLD-6.** A translated world is a translation, and the gaps are a class rather
than a list. Found so far:

| Gap | Effect on the subject |
|---|---|
| `bigserial` is not rewritten, and SQLite has no sequence for a non key column | every sequence column is NULL, so any `order by` that uses one is undefined |
| Every database error is reported under one code of the harness's own | SQLSTATE is not readable, so a subject that tells a duplicate from a failure by code sees every duplicate as a crash |
| RLS, triggers, pgvector | not enforced, so nothing resting on them can be evaluated |

**WORLD-7.** A subject must not be asked to work around a gap in the world. Where
the real engine's behaviour matters to what the subject does, the world has to
provide it, not the subject.

---

## 7. The Postgres world (agreed, not built)

**PGW-1.** A subject may choose a real Postgres world instead of the translated
one. Given a connection, the harness creates a throwaway database, applies the
subject's `schemaFiles` unchanged, runs its seed, and resets between cases.

**PGW-2.** Nothing is translated in this mode. The schema the subject ships is
the schema the evals run against, so WORLD-6's class of gap does not exist and
WORLD-4's exclusions do not apply.

**PGW-3.** `rpcs` is not needed in this mode. The subject's real database
functions are there, so nothing is ported and nothing is fingerprinted.

**PGW-4.** Recording is unchanged. The harness wraps the subject's real client
and emits the same `db_read` and `db_write` Effects, so every assertion written
against the SQLite world still holds.

**PGW-5.** Isolation is unchanged. The database is created for the run and
dropped after it, and an eval never points at a database holding real data.

**PGW-6.** The SQLite world stays the default. It needs nothing installed, which
is what lets the evaluator be pointed at any agent on any machine. Postgres is
chosen by a subject that already has one, which includes every agent built on
openbox-agent.

**PGW-7.** A case's raw SQL access is async in this mode. Preconditions and post
case inspection are written against an async runner.

---

## 8. Not yet written down

These are built and working, and are not specified here because they were not
read closely enough to specify honestly. `Plan.md` has a task for each.

- The pipeline the skill follows, and the artifact each step produces.
- Surface discovery and the coverage map.
- The interview, the intent spec it writes, and the fingerprint that decides when
  it is stale.
- Case generation, and how archetype risk libraries feed it.
- The adversary personas.
- The report format and the regression diff.
- The daemon.

---

## 9. To verify before relying on it

- Whether the recording proxy in a Postgres world can emit the same Effects for
  PostgREST's embedded selects, `or()` filters and count only queries.
- Whether per case reset by truncate is fast enough at suite scale, or whether a
  schema per case is needed.
- sqlite-vec, before any subject relies on a pgvector retriever in the SQLite
  world.

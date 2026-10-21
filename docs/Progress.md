# Progress

Where the work in `Plan.md` has got to. One row per task.

Statuses: `todo`, `doing`, `done`, `blocked`. A milestone check row is done only
when every item in that milestone's "Done when" passes.

**Next task:** T1.8

## Before this plan

Built and working, documented in `Spec.md` sections 1 to 6: the harness, the
skill's pipeline, the assertion engine, the personas, the archetype risk
libraries, the report, the regression diff, the daemon, the SQLite world, and one
wired subject.

## M0. CI

Added after T1.1, at the builder's request.

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T0.1 | Typecheck and tests on Linux and Windows, a privacy scan, a secret scan | done | 2026-10-20 | Four jobs, green first run. Also checks that nothing of the builder's is tracked, since a promise in a gitignore holds until somebody is in a hurry. No format check: this repository has no formatter and choosing one is not mine to do. |

## M1. The Postgres world

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T1.1 | A `World` seam behind `Session.start`, SQLite moved behind it | done | 2026-10-20 | EvalWorld in world/index.ts: seedClient, recordingClient, sql, tables, limits, close. The SQLite world moved behind it with no behaviour change. First tests in this repository, 19 of them, over the seam and over a whole session driven by a fake subject that needs no model. limits() now states WORLD-4 and WORLD-6 out loud so a report can carry them. |
| T1.2 | The Postgres world: throwaway database, schema applied unchanged, reset between cases | done | 2026-10-20 | The subject's schema applied unchanged to a real Postgres, seeded through a real client, emptied between cases. A sequence counts and a duplicate carries a SQLSTATE, which are WORLD-6 inverted. Two guards came out of building it: the harness refuses a database whose subject tables it did not build unless told it is disposable, and every drop or truncate is scoped to the subject's own declared tables, because the first version wrecked a neighbouring project's tables in a shared development database. |
| T1.3 | Seeding through a real client | done | 2026-10-20 | Done inside T1.2: seedClient returns the real Bun.SQL client, which is the thing seed(pg) was always shaped for. Proven by the ADAPT-4 test in postgres-world.test.ts. |
| T1.4 | The recording proxy around a real supabase-js client | done | 2026-10-20 | The subject gets the real client and the harness only watches, so embedded selects, or() filters, counts and error codes are whatever PostgREST does. 11 tests: a real 23505 reaches the subject, an embed works without one level of re-implementation, a conditional claim returns what it changed, and an rpc runs with nothing ported (PGW-3). A query the recorder knows nothing about still works and is still recorded, which is the argument for wrapping rather than re-implementing. A world can borrow a connection, because Bun segfaults under pool churn and a suite opens one world per case. |
| T1.5 | Async raw SQL for preconditions and inspection | done | 2026-10-20 | Done with T1.2 rather than after it: a Postgres world cannot have a synchronous sql, so this was a prerequisite and not a follow up. The SQLite world wraps its synchronous answers, so nothing is slower for it. |
| T1.6 | A subject chooses its world; SQLite stays the default | done | 2026-10-21 | An adapter says which world it wants, SQLite when it says nothing, and EVALS_WORLD overrides it so a suite runs both ways without editing the subject. The test that matters: one fake subject, one script, run in each world, same replies and same Effect stream. Also a process level connection cache, because Bun segfaulted once three test files each opened their own. |
| T1.7 | One subject's suite run both ways, and the two agree | done | 2026-10-21 | Real cases through the real parser and the real assertion engine, run in each world, comparing every assertion outcome and the verdict, not just the Effects. One case asserts on a table no world has, so blind is never green either side. Probing found my first version was weaker than it looked: with the sequence broken, SQLite returns all-null ordering in insertion order, so the replies matched by luck. It compares the rows and their numbers now. Also found that a bigint is a string in one world and a number in the other, which is Known K5. |
| T1.8 | PostgREST in CI, so the recording client's tests run there instead of skipping | todo | | |
| T1.9 | Sequence columns in the SQLite world | done | 2026-10-20 | A trigger per serial column, placed with its table so a backfill further down the migration is numbered too. Covers the subject's writes, its seed script and raw SQL, which patching one insert path would not. Also found by running openbox's real migrations through the translator: `insert ... select ... on conflict` made the whole schema fail to build, and now gets the `where` SQLite's parser needs. openbox's ten tables build in the translated world and its messages, inbox and events all number in order. |
| M1 check | An openbox subject runs with no mocking and no ported functions, the two worlds agree on a suite, and a case needing a real Postgres does not pass in SQLite | done | 2026-10-21 | All three pass. An openbox agent runs under the harness over its own ten tables, with no mock.module and no ported functions. Both worlds give the same replies and the same verdict on the same case. A case resting on a real SQLSTATE passes in Postgres and fails in SQLite, which is the reason the choice exists. The check found a world bug that looked like a subject bug: a json column came back as a string, so the agent replied with nothing at all. |

## M2. Write down what exists

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T2.1 | The pipeline and its artifacts | todo | | |
| T2.2 | Surface discovery and the coverage map | todo | | |
| T2.3 | The interview, the intent spec, the fingerprint | todo | | |
| T2.4 | Case generation and the archetype risk libraries | todo | | |
| T2.5 | The personas | todo | | |
| T2.6 | The report and the regression diff | todo | | |
| T2.7 | The daemon | todo | | |

## M3. The feedback loop, made explicit

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T3.1 | A finding records whether it is the subject's or the layer's | todo | | |
| T3.2 | The report groups layer findings separately | todo | | |
| T3.3 | For an openbox-agent subject, a layer finding names the Spec ID it offends | todo | | |

## Found by pointing openbox-agent at the harness

2026-10-20, during openbox-agent's own T2.6 gate row. Recorded here so it is not
rediscovered.

| What | Where | Status |
|---|---|---|
| DATA-4 style conditional claims work: `update ... where ... returning *`, with every filter a caller needs | `harness/src/capture/db.ts` | fine, no action |
| `bigserial` is not rewritten, so a sequence column is NULL in SQLite and any order using it is undefined | `harness/src/world/translate.ts` | fixed by M1, not patched |
| Every database error arrives under one code, so SQLSTATE cannot be read and a duplicate cannot be told from a crash | `harness/src/capture/db.ts` | fixed by M1. openbox-agent also made its own duplicate detection read the message, so it no longer depends on a code |
| A subject with injected dependencies needs no module mocking and no ported RPCs | `harness/src/runtime.ts` | confirmed, worth saying in the adapter docs |

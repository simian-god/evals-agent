# Progress

Where the work in `Plan.md` has got to. One row per task.

Statuses: `todo`, `doing`, `done`, `blocked`. A milestone check row is done only
when every item in that milestone's "Done when" passes.

**Next task:** T0.1, then T1.2

## Before this plan

Built and working, documented in `Spec.md` sections 1 to 6: the harness, the
skill's pipeline, the assertion engine, the personas, the archetype risk
libraries, the report, the regression diff, the daemon, the SQLite world, and one
wired subject.

## M0. CI

Added after T1.1, at the builder's request.

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T0.1 | Typecheck and tests on Linux and Windows, a privacy scan, a secret scan | doing | | |

## M1. The Postgres world

| Task | What | Status | Date | Note |
|---|---|---|---|---|
| T1.1 | A `World` seam behind `Session.start`, SQLite moved behind it | done | 2026-10-20 | EvalWorld in world/index.ts: seedClient, recordingClient, sql, tables, limits, close. The SQLite world moved behind it with no behaviour change. First tests in this repository, 19 of them, over the seam and over a whole session driven by a fake subject that needs no model. limits() now states WORLD-4 and WORLD-6 out loud so a report can carry them. |
| T1.2 | The Postgres world: throwaway database, schema applied unchanged, reset between cases | todo | | |
| T1.3 | Seeding through a real client | todo | | |
| T1.4 | The recording proxy around a real supabase-js client | todo | | |
| T1.5 | Async raw SQL for preconditions and inspection | todo | | |
| T1.6 | A subject chooses its world; SQLite stays the default | todo | | |
| T1.7 | One subject's suite run both ways, and the two agree | todo | | |
| M1 check | An openbox-agent subject runs green in the Postgres world, no ported RPCs, no module mocking, WORLD-6's gaps gone | todo | | |

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

# Plan

How the rest of evals-agent gets built. `Spec.md` is what it does, `Intent.md` is
why, `Progress.md` is where this has got to.

---

## 1. Where this starts

The harness, the skill, the assertion engine, the personas, the archetype risk
libraries, the report and the regression diff are all built and working. One
subject is wired up. The gap this plan closes is narrower than it looks:

- The eval world is a translation of the subject's schema, and the translation is
  missing things in a way that blames the subject for the harness's gaps
  (Spec WORLD-6).
- Most of what the skill does is not written down (Spec section 8).

---

## 2. Milestones

Each one ships something usable on its own.

### M0. CI

Added after T1.1, at the builder's request. The nineteen tests T1.1 brought
should run on every push rather than when somebody remembers.

| Task | What | Spec IDs |
|---|---|---|
| T0.1 | Typecheck and tests on Linux and Windows, a scan proving nothing of the builder's is tracked, and a secret scan over the full history | SHAPE-3 |

**Done when:** CI is green, and a commit that tracked a subject file would fail it.

### M1. The Postgres world

Spec section 7. A subject with a Postgres of its own evaluates against a real
one, so there is nothing to translate and nothing to be missing.

| Task | What | Spec IDs |
|---|---|---|
| T1.1 | A `World` seam behind `Session.start`, with the SQLite world moved behind it and nothing else changed | WORLD-1 to WORLD-3 |
| T1.2 | The Postgres world: create a throwaway database, apply `schemaFiles` unchanged, reset between cases | PGW-1, PGW-2, PGW-5 |
| T1.3 | Seeding through a real client, so `seed(pg)` gets the thing it was always shaped for | ADAPT-4, PGW-1 |
| T1.4 | The recording proxy around a real supabase-js client, emitting the same Effects | PGW-4 |
| T1.5 | Async raw SQL for preconditions and post case inspection | PGW-7 |
| T1.6 | A subject chooses its world, and the SQLite one stays the default | PGW-6 |
| T1.7 | The same suite run both ways on one subject, and the two agree | PGW-4 |
| M1 check | An openbox-agent subject runs green in the Postgres world, with no ported RPCs and no module mocking, and WORLD-6's three gaps are gone | PGW-1 to PGW-7 |

**Done when:** a suite that cannot pass in the SQLite world because of
WORLD-6 passes in the Postgres world, and an existing subject's suite gives the
same verdicts in both.

### M2. Write down what exists

Spec section 8. Documentation only. No behaviour changes.

| Task | What |
|---|---|
| T2.1 | The pipeline and the artifact each step produces |
| T2.2 | Surface discovery and the coverage map |
| T2.3 | The interview, the intent spec, and the fingerprint that decides staleness |
| T2.4 | Case generation and the archetype risk libraries |
| T2.5 | The personas |
| T2.6 | The report and the regression diff |
| T2.7 | The daemon |

**Done when:** `Spec.md` section 8 is empty, and every section has IDs a case or
a decision can point at.

### M3. The feedback loop, made explicit

Intent section 3. A finding that belongs to the layer underneath should be
reported as such, not patched into one agent.

| Task | What |
|---|---|
| T3.1 | A finding records whether it belongs to the subject or to the layer it is built on |
| T3.2 | The report groups layer findings separately, so they can be taken to that repo |
| T3.3 | For an openbox-agent subject, a layer finding names the Spec ID it offends |

**Done when:** a run against an openbox-agent subject produces a report whose
layer findings can be opened as openbox-agent tasks without rewriting.

---

## 3. Stack

| Need | Choice | Why |
|---|---|---|
| Runtime | Bun | Subjects are loaded in process. Constraint. |
| Language | TypeScript, strict | Constraint. |
| Default world | bun:sqlite | Needs nothing installed, which is what lets the evaluator be pointed at any agent. |
| Optional world | Postgres, via Bun.SQL | Fidelity for a subject that already has one. |
| Data capture | supabase-js | The client subjects use. Others need a sibling module. |
| Cases | YAML, reviewed as CSV | The builder reviews a spreadsheet, not a file tree. |
| Adversary and judge | The builder's own CLI model | No second model to host, no key for the evaluator. |

---

## 4. Risks

| Risk | Likelihood | What we do |
|---|---|---|
| The recording proxy cannot emit the same Effects for PostgREST's embedded selects, `or()` and count queries | Medium | T1.4 checks those three first. If one cannot be recorded faithfully, it is reported as a limit rather than approximated. |
| Per case truncate is too slow at suite scale | Low | A suite case is dominated by model latency, not by the database. Measured in T1.7; a schema per case is the fallback. |
| Two worlds is more to maintain than one | Certain | Accepted, because removing the SQLite one would cost the zero setup promise. The seam in T1.1 is the thing that keeps the cost down. |
| A subject passes in one world and fails in the other | Medium | That is the finding, not the failure. T1.7 exists to surface it. |
| Documenting what exists uncovers behaviour nobody intended | Medium | Expected. M2 records what the code does, and anything that looks wrong becomes a task rather than a quiet fix. |

---

## 5. Decisions log

Every decision made during the build goes here, with the date, what changed and
why.

| Date | Area | Change | Why |
|---|---|---|---|
| 2026-10-20 | The eval world | A real Postgres world is added as an option, and the SQLite one stays the default (Spec section 7) | The translated world is missing things in a way that blames the subject. `bigserial` is not rewritten, so every sequence column is NULL and any order that uses one is undefined; every database error arrives under one code, so SQLSTATE cannot be read and a duplicate is indistinguishable from a crash. Both were found by pointing openbox-agent at the harness. Neither can be fixed in a subject: a sequence has to come from the database. Patching the translation would fix these two and not the class. A subject that already runs Postgres, which is every openbox-agent agent, has nothing to gain from the translation and everything to lose. |
| 2026-10-20 | The eval world | SQLite is not removed | It needs nothing installed, and that is what lets the evaluator be pointed at any agent on any machine. Fidelity is worth having as a choice, not as a requirement. |
| 2026-10-20 | Isolation | An eval never runs against a database holding real data, in either world | An adversarial run is trying to make the agent do damage. It must only ever be able to damage something disposable. A real Postgres world is a throwaway database, not the agent's own. |
| 2026-10-20 | Findings | A finding records whether it belongs to the subject or to the layer underneath (M3) | A confirmation that can be bypassed by nagging is not one agent's bug. Fixed in the layer, every future agent is born without it. Fixed in the agent, the next one inherits it. |

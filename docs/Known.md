# Known

Problems we are living with, and why. One place, so a workaround is not
rediscovered as a mystery.

What goes where:

- **`Known.md`** (this file): a problem that is still true. What it is, what it
  costs, what we did about it, and what would actually resolve it.
- **`Plan.md` decisions log**: a decision that was made and is settled. No longer
  a problem.
- **`Plan.md` risks**: something that might go wrong later.
- **`Spec.md` section 9**: something to check before relying on it.

A row leaves this file when it is resolved, not when it is worked around. Say
which it was.

---

## K1. Bun segfaults under Postgres connection churn

**Status:** open, avoided. Not fixed.

**What happens.** Bun 1.4.0 crashes the process with a segmentation fault once
enough Postgres connections have been opened and dropped. It says so itself:
"this indicates a bug in Bun, not your code." Four connections alive in one
process was enough to reproduce it here, on Windows x64. The threshold was not
characterised further, so treat four as an observation and not a limit.

**What it cost.** Three separate hits, two of them hours apart:

- openbox-agent, T1.3: `openbox migrate` opening its own connection per
  migration. Worked around by having `migrate` accept an open connection.
- evals-agent, T1.4: a suite opening one world per case, each with its own pool.
- evals-agent, T1.6: three test files each opening their own connection.

Each one looked like a different bug before it was understood.

**What we did.** One connection per database for the whole process, cached in
`harness/src/world/postgres.ts`. Every world borrows it, opens none of its own,
and closes none. `closePostgresConnections()` gives them back at teardown.

**What brings it back.** Any new `new SQL(...)` outside that cache. Running cases
in parallel, each wanting a connection. Any feature that needs a second
connection to the same database.

**What would resolve it.** A Bun release that fixes it. The pinned version is
1.4.0 in both repositories; nobody has checked whether a later patch helps, and
moving it affects both. Until then the avoidance is load bearing, not
belt-and-braces.

**Related:** openbox-agent `docs/Known.md` K1, which is the same bug.

---

## K2. A duplicate carries no SQLSTATE in the SQLite world

**Status:** open. Closed only by choosing the Postgres world.

**What happens.** The SQLite world reports every database error under one code of
the harness's own, so Postgres' `23505` is not there to read. A subject that
tells a duplicate from a crash by error code sees every duplicate as a crash.

**What it costs.** Anything resting on a unique constraint: dropping a message
delivered twice, one reply per question, one reminder per key.

**What we did.** Nothing in the harness. openbox-agent changed its own duplicate
detection to read the error message as well as the code, which works in both
worlds. Spec WORLD-6 records the gap, and `limits()` states it at runtime so a
report can carry it.

**What would resolve it.** Running in the Postgres world, where the code is
real. Or the SQLite world mapping its constraint failures onto Postgres codes,
which nobody has asked for.

---

## K3. RLS, triggers and pgvector are not enforced in the SQLite world

**Status:** open by design. Closed only by choosing the Postgres world.

**What happens.** Row level security, triggers and pgvector have no SQLite form.
The translator drops them and records that it did.

**What it costs.** Nothing resting on them can be evaluated in that world. A
subject whose safety depends on RLS would appear to pass.

**What we did.** `limits()` says so, and Spec WORLD-7 says a subject must never
be asked to work around a gap in the world.

**What would resolve it.** The Postgres world. For pgvector specifically,
sqlite-vec, which is Spec section 9's open question.

---

## K4. The sequence the SQLite world keeps can hand out a number twice

**Status:** open, and accepted.

**What happens.** A `serial` column is filled by a trigger that takes
`max + 1`. A real Postgres sequence never hands out a number twice, even after
a delete. This would.

**What it costs.** Nothing inside a case, which starts from a fresh world and
only ever appends. It would matter to a subject that deleted rows and then
relied on a number never recurring.

**What would resolve it.** A counter table rather than `max + 1`, or the
Postgres world.

---

## K5. A bigint is a string in one world and a number in the other

**Status:** open, and only in raw SQL.

**What happens.** Reading a `bigserial` or `bigint` column through the Postgres
world's `sql.all` gives `"1"`. The same read in the SQLite world gives `1`. Bun's
Postgres client returns bigints as strings so a large one cannot lose precision;
SQLite has no such problem and returns a number.

**What it costs.** A precondition or a post case check written against such a
column sees a different type depending on the world. It is not what the subject
sees: a subject reads through PostgREST, which serialises its own way.

**What it cost here.** A test comparing the two worlds' rows, which looked like
a sequence bug and was not.

**What we did.** Nothing in the harness. A comparison that cares about the value
rather than the spelling uses `cast(seq as integer)`, which both engines
understand.

**What would resolve it.** Normalising in the Postgres world's `sql.all`, which
means guessing which columns are bigints and giving up the precision the string
is there to protect. Not worth it for a column nobody counts past a few
thousand, but worth knowing before a case asserts on one.

---

## K6. PostgREST is not in CI, so the recording client's tests skip there

**Status:** open. Scheduled as T1.8.

**What happens.** CI runs a plain Postgres service container, which is enough for
the Postgres world's own tests. The recording client needs PostgREST, because
that is what a subject's client talks to, so its eleven tests skip in CI and run
only on a machine with a Supabase stack.

**What it costs.** The part of the Postgres world a real suite depends on most is
covered locally and not in CI.

**What would resolve it.** T1.8.

---

## K7. The Postgres test files share one database

**Status:** open, and managed by convention.

**What happens.** Three test files run against the same Postgres. Each drops and
empties only the tables its own schema declares, but two files declaring a table
of the same name will collide, and a drop waiting on another file's connection
hangs rather than failing.

**What it cost.** One suite run that passed ten minutes before being stopped,
because `postgrest-capture` and `choose-world` both used a table called
`bookings`.

**What we did.** Each file uses table names of its own. The world only ever
touches tables the subject's schema declares.

**What would resolve it.** A schema per test file, or a database per test file.
Neither has been needed yet.

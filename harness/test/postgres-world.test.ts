// The Postgres world (Spec PGW-1, PGW-2, PGW-3, PGW-5).
//
// The same schema the SQLite tests use, so the two can be read side by
// side. The point of this file is the pair of tests that invert
// world.test.ts's WORLD-6: here a sequence counts and a duplicate carries
// a SQLSTATE, because there is nothing pretending.
//
// Skipped when no database is listening, so the suite stays green on a
// machine with nothing running.
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openPostgresWorld,
  connection,
  databaseAvailable,
  databaseUrl,
  MARKER_TABLE,
  closePostgresConnections,
} from "../src/world/postgres.ts";
import type { EvalWorld } from "../src/world/index.ts";

/**
 * The subject's schema, in the Postgres it actually ships. Nothing here is
 * written for the harness: a sequence, a check constraint, a partial unique
 * index and row level security are all things the translated world either
 * loses or cannot express.
 */
const SCHEMA = `
create table if not exists ob_people (
  id         uuid        primary key default gen_random_uuid(),
  agent_id   text        not null,
  name       text,
  role       text        not null default 'end_user'
             check (role in ('end_user', 'operator')),
  created_at timestamptz not null default now(),
  unique (agent_id, name)
);

create table if not exists ob_messages (
  id         uuid        primary key default gen_random_uuid(),
  seq        bigserial,
  agent_id   text        not null,
  body       text,
  created_at timestamptz not null default now()
);

create index if not exists ob_messages_seq_idx on ob_messages (agent_id, seq);

alter table ob_people enable row level security;
`;

const available = await databaseAvailable();

describe.skipIf(!available)("the Postgres world", () => {
  let dir: string;
  let schemaFile: string;
  const open: EvalWorld[] = [];
  // One connection for the file, borrowed by every world in it. See the
  // note on PostgresWorldOptions.sql: Bun segfaults under pool churn.
  let shared: ReturnType<typeof connection>;

  beforeAll(() => {
    shared = connection();
    dir = mkdtempSync(join(tmpdir(), "evals-pg-"));
    schemaFile = join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA, "utf8");
  });

  afterEach(async () => {
    for (const world of open.splice(0)) await world.close();
  });

  afterAll(async () => {
    // Leave the database as it was found: no tables, no marker.
    const sql = connection();
    // Only what these tests made. Another project's tables live in this
    // same development database and are none of our business.
    await sql.unsafe(
      `drop table if exists public.ob_people, public.ob_messages, public.${MARKER_TABLE}, public.not_ours, public.leftovers, public.someone_elses cascade`,
    );
    await closePostgresConnections();
    rmSync(dir, { recursive: true, force: true });
  });

  // Disposable, because the local stack is a development database. That is
  // the normal case for an eval world, and saying so is the point: the
  // harness will not empty anything it was not told it may.
  async function world(rebuild = true): Promise<EvalWorld> {
    const built = await openPostgresWorld({
      schemaFiles: [schemaFile],
      rebuild,
      disposable: true,
      sql: shared,
    });
    open.push(built);
    return built;
  }

  test("PGW-1: the subject's schema is applied unchanged", async () => {
    const built = await world();

    expect(built.kind).toBe("postgres");
    expect(built.tables.sort()).toEqual(["ob_messages", "ob_people"]);
    // The marker is the harness's, not the subject's, so it is not a table
    // a case should see.
    expect(built.tables).not.toContain(MARKER_TABLE);
  });

  test("PGW-2: a sequence column counts, because there is nothing pretending", async () => {
    // The inverse of world.test.ts's WORLD-6. This is the whole reason
    // this world exists: a conversation's order is a sequence, and in the
    // translated world every one of these came back null.
    const built = await world();

    await built.sql.run("insert into ob_messages (agent_id, body) values ('restaurant','first')");
    await built.sql.run("insert into ob_messages (agent_id, body) values ('restaurant','second')");
    await built.sql.run("insert into ob_messages (agent_id, body) values ('restaurant','third')");

    const rows = await built.sql.all("select body, seq from ob_messages order by seq");
    expect(rows.map((r: { body: string }) => r.body)).toEqual(["first", "second", "third"]);
    expect(rows.every((r: { seq: unknown }) => r.seq !== null)).toBe(true);
  });

  test("PGW-2: a duplicate carries a SQLSTATE, so a subject can tell it apart", async () => {
    // The other half of WORLD-6. A subject that tells a duplicate from a
    // crash works here and cannot there, where every error arrives under
    // one code of the harness's own.
    //
    // Worth knowing where to look: Bun's Postgres client puts the SQLSTATE
    // in `errno` and uses `code` for its own error class, while supabase-js
    // puts it in `code`. Both carry it, under different names, so a subject
    // that reads only one of them should read the message as well.
    const built = await world();

    await built.sql.run("insert into ob_people (agent_id, name) values ('restaurant','Asha')");

    let caught: { code?: unknown; errno?: unknown; message?: unknown } = {};
    try {
      await built.sql.run("insert into ob_people (agent_id, name) values ('restaurant','Asha')");
    } catch (error) {
      caught = error as typeof caught;
    }

    expect([caught.code, caught.errno]).toContain("23505");
    expect(String(caught.message)).toContain("duplicate key value");
  });

  test("PGW-2: a check constraint is enforced, as the subject wrote it", async () => {
    const built = await world();

    let failed = false;
    try {
      await built.sql.run("insert into ob_people (agent_id, name, role) values ('a','b','wizard')");
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("PGW-2: row level security is really on, not skipped", async () => {
    const built = await world();

    const rows = await built.sql.all(
      "select relrowsecurity from pg_class where relname = 'ob_people'",
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  test("ADAPT-4: the subject's own seed code seeds it, through a real client", async () => {
    const built = await world();
    const pg = built.seedClient() as (
      strings: TemplateStringsArray,
      ...vals: unknown[]
    ) => Promise<unknown>;

    await pg`insert into ob_people (agent_id, name) values (${"restaurant"}, ${"Asha"})`;

    expect(await built.sql.all("select name from ob_people")).toEqual([{ name: "Asha" }]);
  });

  test("WORLD-3: the world is emptied between cases, not rebuilt", async () => {
    const first = await world();
    await first.sql.run("insert into ob_people (agent_id, name) values ('restaurant','Asha')");
    expect(await first.sql.all("select count(*)::int as n from ob_people")).toEqual([{ n: 1 }]);
    await first.close();

    // No rebuild: the schema is already there, so this is the fast path a
    // suite actually takes between cases.
    const second = await world(false);
    expect(await second.sql.all("select count(*)::int as n from ob_people")).toEqual([{ n: 0 }]);
    // And a sequence starts again, so case two reads like case one.
    await second.sql.run("insert into ob_messages (agent_id, body) values ('restaurant','x')");
    expect(await second.sql.all("select seq::int as seq from ob_messages")).toEqual([{ seq: 1 }]);
  });

  test("PGW-3: nothing had to be ported, because the functions are real", async () => {
    const built = await world();

    // A Postgres function the subject could call. In the translated world
    // this needs a TypeScript port in the adapter; here it just works.
    const rows = await built.sql.all("select gen_random_uuid() is not null as ok");
    expect(rows[0]?.ok).toBe(true);
  });

  test("PGW-5: it refuses a database whose subject tables it did not build", async () => {
    // The one mistake that would matter: pointed at something real, this
    // world would not be a test run, it would be an outage. The harness
    // cannot tell a development database from a real one by looking, since
    // the subject's own migrations built both, so it does not guess.
    const sql = connection();
    await sql.unsafe(`drop table if exists public.${MARKER_TABLE}`);
    await sql.unsafe("create table if not exists ob_people (id int)");

    await expect(
      openPostgresWorld({ schemaFiles: [schemaFile], rebuild: true, disposable: false }),
    ).rejects.toThrow(/did not build them/);

    // Still there. Nothing was dropped.
    const check = connection();
    const rows = (await check`select tablename from pg_tables where schemaname='public'`) as {
      tablename: string;
    }[];
    expect(rows.map((r) => r.tablename)).toContain("ob_people");
  });

  test("PGW-5: another project's tables in the same database are left alone", async () => {
    // A development Postgres is shared. The first version of this world
    // dropped and truncated every table in the schema, which wrecked a
    // neighbouring project's tables in the course of running a suite.
    const sql = connection();
    await sql.unsafe("drop table if exists public.someone_elses cascade");
    await sql.unsafe("create table public.someone_elses (id int)");
    await sql.unsafe("insert into public.someone_elses (id) values (1), (2)");

    // A rebuild, which is the most destructive thing this world does.
    const built = await world(true);
    expect(built.owns?.()).not.toContain("someone_elses");

    const check = connection();
    const rows = (await check`select count(*)::int as n from public.someone_elses`) as {
      n: number;
    }[];
    // Neither dropped nor emptied.
    expect(rows[0]?.n).toBe(2);
    await check.unsafe("drop table public.someone_elses");
  });

  test("PGW-5: it empties one the builder has called disposable", async () => {
    const sql = connection();
    await sql.unsafe("drop table if exists ob_people, ob_messages cascade");
    await sql.unsafe(`drop table if exists ${MARKER_TABLE}`);
    await sql.unsafe("create table leftovers (id int)");

    const built = await openPostgresWorld({
      schemaFiles: [schemaFile],
      rebuild: true,
      disposable: true,
    });
    open.push(built);

    expect(built.tables.sort()).toEqual(["ob_messages", "ob_people"]);
  });

  test("the world says what it cannot do, and the list is short", async () => {
    const built = await world();

    // Nothing about Postgres being unable to express something, because it
    // can. Only how the world is shared.
    expect(built.limits()).toHaveLength(1);
    expect(built.limits()[0]).toContain("one case at a time");
  });

  test("PGW-4: a recording client needs a key, and says which one", async () => {
    // The client the subject is handed talks to PostgREST, so it needs a
    // service role key. Without one this has to say so rather than hand
    // back something that fails on first use.
    const built = await world();

    expect(() =>
      built.recordingClient.call(built, { rpcs: {}, emit: () => {} }),
    ).not.toThrow(/T1\.4/);
  });
});

test.skipIf(available)("the Postgres world tests skip with no database", () => {
  expect(available).toBe(false);
});

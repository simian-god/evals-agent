// Recording a real supabase-js client (Spec PGW-4).
//
// The claim this file has to support is that assertions written against the
// SQLite world keep working here: `must_write: bookings` has to mean the
// same thing when the client is the real one. So these check the Effects,
// and then check the three corners the re-implemented client had to
// approximate and this one does not: an embedded select, an `or()`, and an
// error with a real SQLSTATE on it.
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import {
  openPostgresWorld,
  databaseAvailable,
  databaseUrl,
  restUrl,
  serviceKey,
  MARKER_TABLE,
} from "../src/world/postgres.ts";
import type { EvalWorld, DbLike } from "../src/world/index.ts";
import type { Effect } from "../src/types.ts";

const SCHEMA = `
create table if not exists guests (
  id    uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name  text
);

create table if not exists bookings (
  id       uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests (id) on delete cascade,
  people   integer not null,
  note     text
);
`;

const available = (await databaseAvailable()) && serviceKey() !== "";

describe.skipIf(!available)("recording a real supabase-js client", () => {
  let dir: string;
  let schemaFile: string;
  const open: EvalWorld[] = [];
  // One connection for the file, borrowed by every world in it. See the
  // note on PostgresWorldOptions.sql: Bun segfaults under pool churn.
  let shared: SQL;

  beforeAll(() => {
    shared = new SQL({ url: databaseUrl(), max: 1 });
    dir = mkdtempSync(join(tmpdir(), "evals-capture-"));
    schemaFile = join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA, "utf8");
  });

  afterEach(async () => {
    for (const world of open.splice(0)) await world.close();
  });

  afterAll(async () => {
    const sql = new SQL({ url: databaseUrl(), max: 1 });
    await sql.unsafe(
      `drop table if exists public.bookings, public.guests, public.${MARKER_TABLE} cascade`,
    );
    await sql.close();
    await shared.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function world(): Promise<{
    world: EvalWorld;
    db: DbLike;
    effects: Omit<Effect, "turn" | "seq" | "ts">[];
  }> {
    const built = await openPostgresWorld({
      schemaFiles: [schemaFile],
      rebuild: open.length === 0,
      disposable: true,
      rest: { url: restUrl(), serviceKey: serviceKey() },
      sql: shared,
    });
    open.push(built);
    const effects: Omit<Effect, "turn" | "seq" | "ts">[] = [];
    const db = built.recordingClient({ rpcs: {}, emit: (e) => effects.push(e) });
    return { world: built, db, effects };
  }

  test("PGW-4: a read becomes a db_read naming the table", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (phone, name) values ('+91900','Asha')");

    const out = await db.from("guests").select("*").eq("phone", "+91900");

    expect(out.error).toBeNull();
    expect(out.data).toHaveLength(1);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("db_read");
    expect(effects[0]?.name).toBe("guests");
    expect(JSON.stringify(effects[0]?.args)).toContain("+91900");
  });

  test("PGW-4: a write becomes a db_write carrying the row", async () => {
    const { db, effects } = await world();

    const out = await db.from("guests").insert({ phone: "+91901", name: "Ravi" }).select();

    expect(out.error).toBeNull();
    const write = effects.find((e) => e.kind === "db_write");
    expect(write?.name).toBe("guests");
    expect(JSON.stringify(write?.args)).toContain("Ravi");
    expect(write?.result).toMatchObject({ rows: 1 });
  });

  test("PGW-4: an update records what it matched on", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (id, phone, name) values ('11111111-1111-1111-1111-111111111111','+91902','Old')");

    await db.from("guests").update({ name: "New" }).eq("phone", "+91902").select();

    const write = effects.find((e) => e.kind === "db_write");
    expect(write?.args).toMatchObject({ op: "update" });
    expect(JSON.stringify(write?.args)).toContain("+91902");
  });

  test("PGW-4: a delete is a write, not a read", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (phone) values ('+91903')");

    await db.from("guests").delete().eq("phone", "+91903");

    expect(effects.at(-1)?.kind).toBe("db_write");
    expect(effects.at(-1)?.args).toMatchObject({ op: "delete" });
  });

  test("PGW-4: a count only query is a read, and the count is recorded", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (phone) values ('+91904'), ('+91905')");

    const out = await db.from("guests").select("*", { count: "exact", head: true });

    expect(out.count).toBe(2);
    expect(effects.at(-1)?.kind).toBe("db_read");
    expect(effects.at(-1)?.result).toMatchObject({ count: 2 });
  });

  test("PGW-4: an embedded select works, because PostgREST is doing it", async () => {
    // The SQLite world supports one level of embed, re-implemented. Here
    // there is nothing to re-implement, so a subject can use embeds the way
    // PostgREST actually defines them.
    const { world: w, db, effects } = await world();
    await w.sql.run(`
      insert into guests (id, phone, name)
      values ('22222222-2222-2222-2222-222222222222', '+91906', 'Meera')
    `);
    await w.sql.run(`
      insert into bookings (guest_id, people, note)
      values ('22222222-2222-2222-2222-222222222222', 4, 'window')
    `);

    const out = await db.from("bookings").select("people, note, guests!inner(name, phone)");

    expect(out.error).toBeNull();
    expect(out.data?.[0]).toMatchObject({ people: 4, guests: { name: "Meera" } });
    expect(effects.at(-1)?.kind).toBe("db_read");
    expect(String((effects.at(-1)?.args as { select?: string }).select)).toContain("guests!inner");
  });

  test("PGW-4: an or() filter works and is recorded", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (phone, name) values ('+91907','Sita'), ('+91908','Gita')");

    const out = await db.from("guests").select("name").or("name.eq.Sita,name.eq.Gita");

    expect(out.error).toBeNull();
    expect(out.data).toHaveLength(2);
    expect(JSON.stringify(effects.at(-1)?.args)).toContain("name.eq.Sita");
  });

  test("PGW-4: a refused write is an error Effect, and the error reaches the subject", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (phone) values ('+91909')");

    const out = await db.from("guests").insert({ phone: "+91909" }).select();

    // Returned, not thrown, which is what supabase-js does and therefore
    // what the subject's own error handling is written against.
    expect(out.error).not.toBeNull();
    // The payoff: a real SQLSTATE, which the other world cannot give.
    expect(out.error.code).toBe("23505");
    expect(effects.at(-1)?.kind).toBe("error");
    expect(effects.at(-1)?.name).toBe("guests");
  });

  test("PGW-4: a conditional claim returns the rows it changed", async () => {
    // What every concurrent claim in a subject rests on, through the real
    // client this time.
    const { world: w, db } = await world();
    await w.sql.run(
      "insert into guests (id, phone, name) values ('33333333-3333-3333-3333-333333333333','+91910','free')",
    );

    const won = await db
      .from("guests")
      .update({ name: "taken" })
      .eq("phone", "+91910")
      .eq("name", "free")
      .select();
    const lost = await db
      .from("guests")
      .update({ name: "taken twice" })
      .eq("phone", "+91910")
      .eq("name", "free")
      .select();

    expect(won.data).toHaveLength(1);
    expect(lost.data).toHaveLength(0);
  });

  test("PGW-4: a query the recorder knows nothing about still works", async () => {
    // The reason to wrap the real client rather than re-implement it: a
    // subject using a corner nobody here thought about keeps working, and
    // the Effect is still emitted.
    const { world: w, db, effects } = await world();
    await w.sql.run("insert into guests (phone, name) values ('+91911','Zed'), ('+91912','Amy')");

    const out = await db
      .from("guests")
      .select("name")
      .order("name", { ascending: true })
      .range(0, 0);

    expect(out.error).toBeNull();
    expect(out.data).toEqual([{ name: "Amy" }]);
    expect(effects.at(-1)?.kind).toBe("db_read");
  });

  test("PGW-3: an rpc is the real function, with nothing ported", async () => {
    const { world: w, db, effects } = await world();
    await w.sql.run(`
      create or replace function guest_count() returns integer
      language sql as $$ select count(*)::int from guests $$
    `);
    await w.sql.run("notify pgrst, 'reload schema'");
    await new Promise((r) => setTimeout(r, 1_500));
    await w.sql.run("insert into guests (phone) values ('+91913')");

    // No entry in `rpcs`, because there is nothing to port.
    const out = await db.rpc("guest_count");

    expect(out.error).toBeNull();
    expect(out.data).toBe(1);
    expect(effects.at(-1)?.name).toBe("rpc:guest_count");

    await w.sql.run("drop function if exists guest_count()");
  });
});

test.skipIf(available)("the capture tests skip without a database and a service key", () => {
  expect(available).toBe(false);
});

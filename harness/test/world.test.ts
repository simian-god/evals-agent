// The world seam (Spec WORLD-1 to WORLD-6).
//
// These are the first tests in this repository. They exist because the
// Postgres world (Spec section 7) is an addition behind this seam, and an
// addition is only safe if the thing it sits beside is pinned down.
//
// Two of them deliberately assert a limitation rather than a feature: the
// SQLite world cannot order by a sequence and cannot report a SQLSTATE.
// Those are WORLD-6, written as tests so they are facts rather than
// comments, and so the Postgres world's tests can show the difference.
import { test, expect, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteWorld } from "../src/world/sqlite.ts";
import type { EvalWorld } from "../src/world/index.ts";
import type { Effect } from "../src/types.ts";

/** A subject's schema, in the Postgres the subject actually ships. */
const SCHEMA = `
create table if not exists ob_people (
  id        uuid        primary key default gen_random_uuid(),
  agent_id  text        not null,
  name      text,
  created_at timestamptz not null default now(),
  unique (agent_id, name)
);

create table if not exists ob_messages (
  id        uuid        primary key default gen_random_uuid(),
  seq       bigserial,
  agent_id  text        not null,
  body      text
);

alter table ob_people enable row level security;
`;

let dir: string;
let schemaFile: string;
let schemaPath: string;
const open: EvalWorld[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "evals-world-"));
  schemaFile = join(dir, "schema.sql");
  schemaPath = join(dir, "world.schema.sql");
  writeFileSync(schemaFile, SCHEMA, "utf8");
});

afterEach(() => {
  for (const world of open.splice(0)) world.close();
});

function world(): EvalWorld {
  const built = openSqliteWorld({ schemaFiles: [schemaFile], schemaPath, rebuild: true });
  open.push(built);
  return built;
}

function recorder() {
  const effects: Omit<Effect, "turn" | "seq" | "ts">[] = [];
  return {
    effects,
    options: { rpcs: {}, emit: (e: Omit<Effect, "turn" | "seq" | "ts">) => effects.push(e) },
  };
}

test("WORLD-1: the world is built from the subject's own schema", () => {
  const built = world();

  expect(built.kind).toBe("sqlite");
  expect(built.tables.sort()).toEqual(["ob_messages", "ob_people"]);
});

test("WORLD-1: raw SQL reads and writes the world", async () => {
  const built = world();

  await built.sql.run("insert into ob_people (id, agent_id, name) values (?, ?, ?)", [
    "p1",
    "restaurant",
    "Asha",
  ]);
  expect(await built.sql.all("select name from ob_people")).toEqual([{ name: "Asha" }]);
});

test("ADAPT-4: the subject's own seed code can seed it", async () => {
  const built = world();
  const pg = built.seedClient() as (
    strings: TemplateStringsArray,
    ...vals: unknown[]
  ) => Promise<unknown>;

  // Written the way a subject's seed script writes it.
  await pg`insert into ob_people (agent_id, name) values (${"restaurant"}, ${"Asha"})`;

  expect(await built.sql.all("select agent_id, name from ob_people")).toEqual([
    { agent_id: "restaurant", name: "Asha" },
  ]);
});

test("EFF-1: a read through the recording client becomes an Effect", async () => {
  const built = world();
  const seen = recorder();
  const db = built.recordingClient(seen.options);

  await built.sql.run("insert into ob_people (id, agent_id, name) values ('p1','restaurant','Asha')");
  const out = await db.from("ob_people").select("*").eq("agent_id", "restaurant");

  expect(out.error).toBeNull();
  expect(out.data).toHaveLength(1);
  expect(seen.effects.map((e) => e.kind)).toContain("db_read");
});

test("EFF-1: a write through the recording client becomes an Effect with its row", async () => {
  const built = world();
  const seen = recorder();
  const db = built.recordingClient(seen.options);

  const out = await db
    .from("ob_people")
    .insert({ id: "p2", agent_id: "restaurant", name: "Ravi" })
    .select();

  expect(out.error).toBeNull();
  const write = seen.effects.find((e) => e.kind === "db_write");
  expect(write?.name).toBe("ob_people");
  expect(JSON.stringify(write?.args)).toContain("Ravi");
});

test("WORLD-2: a conditional update returns the rows it changed", async () => {
  // What every concurrent claim in a subject rests on, so the one thing
  // this world must not get wrong.
  const built = world();
  const db = built.recordingClient(recorder().options);

  await built.sql.run("insert into ob_people (id, agent_id, name) values ('p1','restaurant','free')");

  const won = await db
    .from("ob_people")
    .update({ name: "taken" })
    .eq("id", "p1")
    .eq("name", "free")
    .select();
  const lost = await db
    .from("ob_people")
    .update({ name: "taken by someone else" })
    .eq("id", "p1")
    .eq("name", "free")
    .select();

  expect(won.data).toHaveLength(1);
  expect(lost.data).toHaveLength(0);
});

test("WORLD-6: a sequence column has no sequence here, and the world says so", async () => {
  // Not a bug in a subject. `bigserial` has no SQLite form, so the column
  // exists and nothing fills it, and any order that uses it is undefined.
  // This is what the Postgres world is for (Spec section 7).
  const built = world();

  await built.sql.run("insert into ob_messages (id, agent_id, body) values ('m1','restaurant','first')");
  await built.sql.run("insert into ob_messages (id, agent_id, body) values ('m2','restaurant','second')");

  expect(await built.sql.all("select seq from ob_messages")).toEqual([{ seq: null }, { seq: null }]);
  expect(built.limits().join(" ")).toContain("sequence");
});

test("WORLD-6: a duplicate carries no SQLSTATE here, and the world says so", async () => {
  const built = world();
  const db = built.recordingClient(recorder().options);

  await db.from("ob_people").insert({ id: "p1", agent_id: "restaurant", name: "Asha" }).select();
  const again = await db
    .from("ob_people")
    .insert({ id: "p9", agent_id: "restaurant", name: "Asha" })
    .select();

  // The unique constraint is enforced, which is the good half.
  expect(again.error).not.toBeNull();
  // The code is not Postgres's 23505, which is the half a subject trips on.
  expect(again.error.code).not.toBe("23505");
  expect(String(again.error.message)).toContain("UNIQUE");
  expect(built.limits().join(" ")).toContain("SQLSTATE");
});

test("WORLD-4: what the translation skipped is reported, not hidden", () => {
  const built = world();

  // RLS has no SQLite form and is dropped. A subject must not be relying
  // on it, and the report has to be able to say so.
  expect(built.limits().join(" ")).toContain("RLS");
});

test("WORLD-3: each case gets its own world", async () => {
  const first = world();
  await first.sql.run("insert into ob_people (id, agent_id, name) values ('p1','restaurant','Asha')");
  expect(await first.sql.all("select count(*) as n from ob_people")).toEqual([{ n: 1 }]);

  const second = world();
  expect(await second.sql.all("select count(*) as n from ob_people")).toEqual([{ n: 0 }]);
});

test("the world closes cleanly, and twice is not an error", () => {
  const built = openSqliteWorld({ schemaFiles: [schemaFile], schemaPath, rebuild: true });
  built.close();
  expect(() => built.close()).not.toThrow();
});

test("teardown", () => {
  rmSync(dir, { recursive: true, force: true });
  expect(true).toBe(true);
});

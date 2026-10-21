// Which world a case runs in (Spec PGW-6), and the same subject in both.
//
// The last two tests are the point of the file: one fake subject, one
// script, run in each world, and the same Effects either side. That is what
// has to be true for a suite written against one world to mean anything in
// the other.
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.ts";
import { dbProxy } from "../src/runtime.ts";
import { chosenKind } from "../src/world/open.ts";
import {
  connection,
  databaseAvailable,
  databaseUrl,
  restUrl,
  serviceKey,
  MARKER_TABLE,
  closePostgresConnections,
} from "../src/world/postgres.ts";
import type { AdapterContext, SubjectAdapter, SubjectSession } from "../src/types.ts";

const SCHEMA = `
create table if not exists chosen_bookings (
  id       uuid    primary key default gen_random_uuid(),
  seq      bigserial,
  guest    text    not null,
  people   integer not null
);
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "evals-choose-"));
  writeFileSync(join(dir, "schema.sql"), SCHEMA, "utf8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A subject that books, and reads its own writes back in order. */
function adapter(world?: SubjectAdapter["world"]): SubjectAdapter {
  return {
    id: "chooser",
    root: dir,
    schemaFiles: [join(dir, "schema.sql")],
    fingerprintFiles: [],
    env: {},
    rpcs: {},
    ...(world !== undefined ? { world } : {}),

    async seed(pg: unknown) {
      const tag = pg as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
      await tag`insert into chosen_bookings (guest, people) values (${"Seeded"}, ${2})`;
    },

    async open(ctx: AdapterContext): Promise<SubjectSession> {
      return {
        async say(text: string) {
          await dbProxy.from("chosen_bookings").insert({ guest: text, people: 4 }).select();
          const all = await dbProxy.from("chosen_bookings").select("guest").order("seq");
          const guests = (all.data ?? []).map((row: { guest: string }) => row.guest);
          ctx.emit({ kind: "outbound_msg", name: "reply", args: { body: guests.join(", ") } });
        },
        async close() {},
      };
    },
  };
}

describe("choosing a world", () => {
  test("PGW-6: SQLite when the subject says nothing", () => {
    expect(chosenKind({}, {})).toBe("sqlite");
    expect(chosenKind({ world: "sqlite" }, {})).toBe("sqlite");
    expect(chosenKind({ world: { kind: "sqlite" } }, {})).toBe("sqlite");
  });

  test("PGW-6: Postgres when the subject asks for it", () => {
    expect(chosenKind({ world: "postgres" }, {})).toBe("postgres");
    expect(chosenKind({ world: { kind: "postgres", disposable: true } }, {})).toBe("postgres");
  });

  test("PGW-6: the environment wins, so a suite runs both ways unedited", () => {
    // The evaluator never edits the subject it grades, so switching worlds
    // cannot require editing the adapter.
    expect(chosenKind({ world: "sqlite" }, { EVALS_WORLD: "postgres" })).toBe("postgres");
    expect(chosenKind({ world: "postgres" }, { EVALS_WORLD: "sqlite" })).toBe("sqlite");
    // Anything else is ignored rather than guessed at.
    expect(chosenKind({ world: "postgres" }, { EVALS_WORLD: "mysql" })).toBe("postgres");
  });

  test("a session runs in the SQLite world by default", async () => {
    const s = new Session({
      adapter: adapter(),
      schemaPath: join(dir, "world.schema.sql"),
      rebuildSchema: true,
    });
    await s.start();

    expect(s.world.kind).toBe("sqlite");
    const replies = await s.say("Asha");
    expect(replies).toEqual(["Seeded, Asha"]);

    await s.close();
  });
});

const available = (await databaseAvailable()) && serviceKey() !== "";

describe.skipIf(!available)("the same subject in both worlds", () => {
  let shared: ReturnType<typeof connection>;

  beforeAll(() => {
    shared = connection();
  });

  afterAll(async () => {
    await shared.unsafe(`drop table if exists public.chosen_bookings, public.${MARKER_TABLE} cascade`);
    await closePostgresConnections();
  });

  afterEach(() => {
    delete process.env["EVALS_WORLD"];
  });

  /** One script, one world, the Effects it produced. */
  async function run(kind: "sqlite" | "postgres") {
    process.env["EVALS_WORLD"] = kind;
    const s = new Session({
      adapter: adapter({
        kind: "postgres",
        disposable: true,
        rest: { url: restUrl(), serviceKey: serviceKey() },
      }),
      schemaPath: join(dir, "world.schema.sql"),
      rebuildSchema: true,
    });
    await s.start();
    const replies = [...(await s.say("Asha")), ...(await s.say("Ravi"))];
    const effects = s.effects.map((e) => `${e.turn}:${e.kind}:${e.name}`);
    const world = s.world.kind;
    await s.close();
    return { replies, effects, world };
  }

  test("PGW-4: the two worlds agree on what the subject did", async () => {
    const sqlite = await run("sqlite");
    const postgres = await run("postgres");

    expect(sqlite.world).toBe("sqlite");
    expect(postgres.world).toBe("postgres");

    // The same conversation, including the order the rows came back in,
    // which is what the sequence fix was for.
    expect(sqlite.replies).toEqual(["Seeded, Asha", "Seeded, Asha, Ravi"]);
    expect(postgres.replies).toEqual(sqlite.replies);

    // And the same Effect stream, which is what assertions are written
    // against.
    expect(postgres.effects).toEqual(sqlite.effects);
  });

  test("PGW-2: only the Postgres world can tell a duplicate by its code", async () => {
    // Where the two still differ, and the reason the choice exists. The
    // SQLite world enforces the constraint but cannot name it; a subject
    // that reads a code has to read the message too.
    process.env["EVALS_WORLD"] = "sqlite";
    const onSqlite = new Session({
      adapter: adapter(),
      schemaPath: join(dir, "world.schema.sql"),
      rebuildSchema: true,
    });
    await onSqlite.start();
    const limits = onSqlite.world.limits().join(" ");
    await onSqlite.close();

    expect(limits).toContain("SQLSTATE");

    process.env["EVALS_WORLD"] = "postgres";
    const onPostgres = new Session({
      adapter: adapter({
        kind: "postgres",
        disposable: true,
        rest: { url: restUrl(), serviceKey: serviceKey() },
      }),
      schemaPath: join(dir, "world.schema.sql"),
      rebuildSchema: true,
    });
    await onPostgres.start();
    const pgLimits = onPostgres.world.limits().join(" ");
    await onPostgres.close();

    expect(pgLimits).not.toContain("SQLSTATE");
  });
});

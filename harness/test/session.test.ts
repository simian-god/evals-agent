// A case session, end to end, with a fake subject.
//
// The subject here does nothing but write a row and say something back, and
// it reaches the database the way a real subject does: through the proxy
// `runtime.ts` binds, so the whole chain is exercised. World, seed,
// recording client, effect stream, transcript, teardown.
//
// It needs no model and no network, so it can run on every change. There
// was no test over `Session` before the world moved behind a seam, which is
// the kind of gap worth closing before adding a second world beside it.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.ts";
import { dbProxy } from "../src/runtime.ts";
import type { AdapterContext, SubjectAdapter, SubjectSession } from "../src/types.ts";

const SCHEMA = `
create table if not exists bookings (
  id        uuid        primary key default gen_random_uuid(),
  guest     text        not null,
  people    integer     not null,
  created_at timestamptz not null default now()
);
`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "evals-session-"));
  writeFileSync(join(dir, "schema.sql"), SCHEMA, "utf8");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A subject that books a table when asked, and refuses twice for the same
 * guest. Reaches the database through the proxy, as a real one does.
 */
function fakeAdapter(seen: { seeded: boolean }): SubjectAdapter {
  return {
    id: "fake",
    root: dir,
    schemaFiles: [join(dir, "schema.sql")],
    fingerprintFiles: [],
    env: { FAKE_SUBJECT: "1" },
    rpcs: {},

    async seed(pg: unknown) {
      const tag = pg as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
      await tag`insert into bookings (guest, people) values (${"Existing"}, ${2})`;
      seen.seeded = true;
    },

    async open(ctx: AdapterContext): Promise<SubjectSession> {
      return {
        async say(text: string) {
          if (!text.includes("book")) {
            ctx.emit({ kind: "outbound_msg", name: "reply", args: { body: "I can only book." } });
            return;
          }
          const out = await dbProxy
            .from("bookings")
            .insert({ guest: "Asha", people: 4 })
            .select();
          ctx.emit({
            kind: "outbound_msg",
            name: "reply",
            args: { body: out.error ? "Could not book." : "Booked for 4." },
          });
        },
        async inject(kind: string, payload: string) {
          ctx.emit({ kind: "outbound_template", name: kind, args: { payload } });
        },
        async close() {},
      };
    },
  };
}

function session(seen: { seeded: boolean }): Session {
  return new Session({
    adapter: fakeAdapter(seen),
    schemaPath: join(dir, "world.schema.sql"),
    rebuildSchema: true,
  });
}

test("a session builds the world, seeds it with the subject's own code, and opens the subject", async () => {
  const seen = { seeded: false };
  const s = session(seen);
  await s.start();

  expect(seen.seeded).toBe(true);
  expect(s.world.kind).toBe("sqlite");
  expect(s.world.tables).toEqual(["bookings"]);
  // The subject's seed is the fixture, not something re-typed here.
  expect(await s.sql.all("select guest from bookings")).toEqual([{ guest: "Existing" }]);

  await s.close();
});

test("ADAPT-3: the subject reaches the world through the bound proxy", async () => {
  const s = session({ seeded: false });
  await s.start();

  const replies = await s.say("please book a table");

  expect(replies).toEqual(["Booked for 4."]);
  expect(await s.sql.all("select guest from bookings order by guest")).toEqual([
    { guest: "Asha" },
    { guest: "Existing" },
  ]);

  await s.close();
});

test("EFF-2: effects carry the turn they happened on, in order", async () => {
  const s = session({ seeded: false });
  await s.start();

  await s.say("hello");
  await s.say("please book a table");

  const kinds = s.effects.map((e) => `${e.turn}:${e.kind}`);
  expect(kinds[0]).toBe("1:outbound_msg");
  expect(kinds).toContain("2:db_write");
  expect(s.effects.map((e) => e.seq)).toEqual(s.effects.map((_, i) => i + 1));

  await s.close();
});

test("the transcript holds both sides, by turn", async () => {
  const s = session({ seeded: false });
  await s.start();

  await s.say("hello");

  expect(s.transcript).toEqual([
    { turn: 1, role: "adversary", text: "hello" },
    { turn: 1, role: "subject", text: "I can only book." },
  ]);
  expect(s.turns).toBe(1);

  await s.close();
});

test("ADAPT-6: an out of band event is a turn of its own", async () => {
  const s = session({ seeded: false });
  await s.start();

  await s.inject("staff_button", "confirm");

  expect(s.turns).toBe(1);
  expect(s.effects.at(-1)?.kind).toBe("outbound_template");
  expect(s.transcript[0]?.text).toContain("staff_button");

  await s.close();
});

test("WORLD-3: a second session starts from the seed again, not from the last one", async () => {
  const first = session({ seeded: false });
  await first.start();
  await first.say("please book a table");
  expect(await first.sql.all("select count(*) as n from bookings")).toEqual([{ n: 2 }]);
  await first.close();

  const second = session({ seeded: false });
  await second.start();
  expect(await second.sql.all("select count(*) as n from bookings")).toEqual([{ n: 1 }]);
  await second.close();
});

test("the subject cannot reach the database once the session is closed", async () => {
  const s = session({ seeded: false });
  await s.start();
  await s.close();

  // What `runtime.ts` exists to catch: a subject holding a module level
  // reference and using it between cases.
  expect(() => dbProxy.from("bookings")).toThrow(/outside a case session/);
});

// Adapter sanity check 2 of 2: the WRITE path.
//
// Proves that a conversation which should cause a side effect actually produces
// one: a tool call captured with its arguments, a row in the eval world, and an
// outbound message. If this passes, assertions can be trusted.
//
//   bun --env-file <subject>/.env harness/dev/check-write-path.ts <subject-id> "turn one" "turn two"
import { join } from "node:path";
import { Session } from "../src/session.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const subjectId = process.argv[2];
if (!subjectId) {
  console.error('usage: bun harness/dev/check-write-path.ts <subject-id> "turn one" ["turn two" ...]');
  process.exit(1);
}
const turns = process.argv.slice(3);
if (!turns.length) turns.push("2 butter naan please", "yes confirm");

const mod = await import(join(REPO, "subjects", subjectId, "adapter.ts"));
const { adapter, FIXTURE, bindRoomDirect } = mod;

const s = new Session({
  adapter,
  schemaPath: join(REPO, "subjects", subjectId, "world.schema.sql"),
});
await s.start();
if (bindRoomDirect && FIXTURE) bindRoomDirect(s.sql, FIXTURE.guestPhone);

for (const t of turns) {
  const r = await s.say(t);
  console.log(`\n[USER]  ${t}\n[AGENT] ${r.join(" | ")}`);
}

const tools = s.effects.filter((e) => e.kind === "llm_tool");
const writes = s.effects.filter((e) => e.kind === "db_write");
const out = s.effects.filter((e) => e.kind === "outbound_template");
const errors = s.effects.filter((e) => e.kind === "error");

console.log("\nTOOL CALLS:", tools.map((e) => `${e.name} ${JSON.stringify(e.args)}`));
console.log("WRITES:", [...new Set(writes.map((e) => e.name))].join(", ") || "(none)");
console.log("TEMPLATES:", out.map((e) => `${e.name} -> ${JSON.stringify((e.args as any)?.to)}`));
console.log("ERRORS:", errors.map((e) => `${e.name}: ${e.result}`));

const ok = tools.length > 0 && writes.length > 0 && errors.length === 0;
console.log(ok ? "\nOK - the write path is observable" : "\nFAIL - no tool call, no write, or an error effect");
await s.close();
process.exit(ok ? 0 : 1);

// Adapter sanity check 1 of 2: the READ path.
//
// Proves the eval world builds from the subject's schema, that the subject's own
// seed script populates it, and that one live turn produces a complete effect
// stream. Run this first when onboarding a new subject.
//
//   bun --env-file <subject>/.env harness/dev/check-read-path.ts <subject-id> ["a question"]
import { join } from "node:path";
import { Session } from "../src/session.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const subjectId = process.argv[2];
if (!subjectId) {
  console.error("usage: bun harness/dev/check-read-path.ts <subject-id> [question]");
  process.exit(1);
}
const question = process.argv[3] ?? "what time is breakfast?";

const mod = await import(join(REPO, "subjects", subjectId, "adapter.ts"));
const { adapter, FIXTURE, bindRoomDirect } = mod;

const s = new Session({
  adapter,
  schemaPath: join(REPO, "subjects", subjectId, "world.schema.sql"),
  rebuildSchema: true,
});
await s.start();

console.log("tables:", s.sql.all("select name from sqlite_master where type='table'").length);
if (bindRoomDirect && FIXTURE) bindRoomDirect(s.sql, FIXTURE.guestPhone);

const replies = await s.say(question);
console.log(`\n[USER]  ${question}`);
console.log(`[AGENT] ${replies.join(" | ")}`);

console.log("\nEFFECTS:");
for (const e of s.effects) {
  console.log(` ${e.seq} ${e.kind} ${e.name} ${JSON.stringify(e.result ?? "").slice(0, 90)}`);
}
const errors = s.effects.filter((e) => e.kind === "error");
console.log(errors.length ? `\nFAIL - ${errors.length} error effect(s) on the happy path` : "\nOK - no error effects");
await s.close();
process.exit(errors.length ? 1 : 0);

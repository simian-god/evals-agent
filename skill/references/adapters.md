# Onboarding a new subject

The adapter is the only subject-specific code in this repo. It lives at
`subjects/<id>/adapter.ts` and exports `adapter: SubjectAdapter`.
`subjects/frontdes/adapter.ts` is the worked example.

## What the harness needs from a subject

| field | what it is | how to find it |
|---|---|---|
| `id` | short name, matches the directory | - |
| `root` | the subject's repo root | - |
| `schemaFiles` | DDL sources in apply order | `schema.sql` + `migrations/*.sql` |
| `fingerprintFiles` | files that decide whether the intent spec is stale | prompt, tool defs, handlers, guard, seed, schema |
| `env` | config that neutralises every real edge | the subject's env module |
| `seed(pg)` | call the subject's OWN seed code | its migrate/seed script |
| `rpcs` | database functions ported to TS | grep for `.rpc(` |
| `open(ctx)` | start a conversation session | its entry point |

## The three seams

**1. Injected dependencies.** If the subject takes its providers as arguments
(`handleInbound(msg, { llm, bsp, analytics })`), pass the harness's capturing
wrappers and you are done. This is the easy case and the one to ask for when
designing a new agent.

**2. Module singletons.** If the subject does `export const db = createClient()`
at module load, use `mock.module()` to replace that module with the harness
proxy *before* importing anything that imports it:

```ts
mock.module(SRC + "/db/client.ts", () => ({ db: dbProxy }));
const { handleInbound } = await import(SRC + "/agent/loop.ts");
```

Order matters. An import that happens first captures the real client.

**3. Postgres functions.** Anything called through `.rpc()` has no SQLite
equivalent. Port it to TS in `rpcs`, and put the `.sql` file in
`fingerprintFiles` so the port is flagged when the original changes. If a
function cannot be honestly ported (pgvector similarity, for instance), make it
*throw* - a subject that degrades gracefully will take its fallback path, and
the thrown error is recorded as a known limitation. Never fake its output.

## The env contract

Every entry in `env` exists to close a real edge. Audit it before the first run
and state the audit in the report:

- messaging/notification providers -> a local double
- analytics -> noop
- third-party APIs -> mock provider
- database credentials -> junk values, so a code path that bypasses the proxy
  fails loudly instead of reaching production
- rate limits -> raised, so a suite is not throttled; one case overrides them
  back down to assert the limit still fires
- anything embedding/retrieval -> whatever the subject's production default is,
  so the eval exercises the same path

The model API is the single permitted live call. It is the thing under test.

## Writing `open()`

Return a session with `say(text)`, optional `inject(kind, payload)`, and
`close()`. `say` must resolve only when the subject has finished reacting -
including its writes and outbound messages - or the effect stream will be
missing effects that arrive late.

Per-case env overrides arrive in `ctx.vars` as `env.NAME` keys. Apply them by
mutating the subject's loaded config object, since its module-level env was
frozen at import:

```ts
const { env } = await import(SRC + "/config/env.ts");
for (const [k, v] of Object.entries(ctx.vars)) {
  if (k.startsWith("env.")) (env as any)[k.slice(4)] = coerceEnv(v);
}
```

## Preconditions without model turns

Export a helper (like `bindRoomDirect`) for any state a case needs that would
otherwise cost a conversation turn. Build it on the subject's own primitives -
reuse the ported RPC, do not hand-write equivalent SQL, or the precondition and
the real path will drift.

## Record what the harness cannot see

Write `subjects/<id>/limitations.md` - one bullet per blind spot. Every report
appends it verbatim to its limitations section, and a subject without the file
gets a visible nudge instead of silence. Things that belong there: database
functions you ported by hand, retrieval or ranking behaviour the eval world
cannot reproduce, surfaces no case touches, and trust assumptions you have
accepted by design.

A report that does not state its blind spots invites someone to read a pass as
proof.

## Checklist before the first run

- [ ] `evals world --subject <id>` translates the schema; the skip list is read
      and understood
- [ ] `evals surface --subject <id>` lists every tool and write you expected
- [ ] a one-turn ad-hoc session gets a sensible reply
- [ ] a write-path session produces the row you expect in `evals sql`
- [ ] the effect stream contains zero `error` effects on the happy path
- [ ] `env` has no live edge but the model

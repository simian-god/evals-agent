// Session daemon.
//
// Why a daemon: the adversary is the CALLING model (Claude Code / Codex), which
// speaks one turn at a time. A conversation must therefore survive between
// commands, and replaying earlier turns to rebuild it would re-bill every model
// call and re-roll every nondeterministic reply. So sessions live here, in
// memory, and the CLI is a thin client.
//
// Nothing here is exposed beyond localhost, and the daemon holds no credentials
// of its own - it inherits the subject's .env for the one live edge (the LLM).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Session } from "./session.ts";
import { evaluate, verdict, type Known } from "./grade/assert.ts";
import { loadCases } from "./cases.ts";
import type { EvalCase, SubjectAdapter } from "./types.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env.EVALS_PORT ?? 47821);

interface Live {
  id: string;
  subject: string;
  session: Session;
  evalCase?: EvalCase;
  adapter: SubjectAdapter;
  startedAt: string;
}

const live = new Map<string, Live>();
const adapters = new Map<string, SubjectAdapter>();

async function getAdapter(subject: string): Promise<SubjectAdapter> {
  if (!adapters.has(subject)) {
    const mod = await import(join(REPO, "subjects", subject, "adapter.ts"));
    adapters.set(subject, mod.adapter as SubjectAdapter);
  }
  return adapters.get(subject)!;
}

function knownFor(l: Live): Known {
  return {
    tools: (l.adapter as any).toolNames ?? ["dispatch_task", "escalate_to_owner"],
    tables: l.session.world.tables,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });

async function handle(path: string, body: any): Promise<Response> {
  switch (path) {
    case "/health":
      return json({ ok: true, sessions: [...live.keys()], port: PORT, repo: REPO });

    case "/start": {
      const adapter = await getAdapter(body.subject);
      const cases = body.case
        ? loadCases(join(REPO, "subjects", body.subject, "cases"), [body.case])
        : [];
      const evalCase = cases[0];
      if (body.case && !evalCase) return json({ error: `case "${body.case}" not found` }, 404);

      const vars: Record<string, string> = { ...(body.vars ?? {}) };
      for (const [k, v] of Object.entries(evalCase?.preconditions?.env ?? {})) vars["env." + k] = String(v);

      const session = new Session({
        adapter,
        schemaPath: join(REPO, "subjects", body.subject, "world.schema.sql"),
        vars,
        rebuildSchema: Boolean(body.rebuildSchema),
      });
      await session.start();

      // Preconditions that shouldn't cost a model turn.
      if (evalCase?.preconditions?.bind_room) {
        const mod = await import(join(REPO, "subjects", body.subject, "adapter.ts"));
        mod.bindRoomDirect?.(session.sql, vars.guest_phone ?? mod.FIXTURE?.guestPhone);
      }
      for (const row of evalCase?.preconditions?.fixture_overrides ?? []) {
        // An override is either `{sql: "..."}` (mutate the seeded world, e.g.
        // rename a department so an ilike lookup misses) or `{table, ...cols}`
        // (insert a row, e.g. a second room with another guest's order).
        if ((row as any).sql) {
          await session.sql.run(String((row as any).sql));
          continue;
        }
        const { table, ...cols } = row as any;
        const keys = Object.keys(cols);
        await session.sql.run(
          `insert into "${table}" (${keys.map((k) => `"${k}"`).join(",")}) values (${keys.map(() => "?").join(",")})`,
          keys.map((k) => (typeof cols[k] === "object" ? JSON.stringify(cols[k]) : cols[k])),
        );
      }

      const id = `${body.subject}-${evalCase?.id ?? "adhoc"}-${Date.now().toString(36)}`;
      live.set(id, { id, subject: body.subject, session, evalCase, adapter, startedAt: new Date().toISOString() });
      return json({
        session: id,
        case: evalCase?.id ?? null,
        turn_cap: evalCase?.turn_cap ?? 8,
        persona: evalCase?.persona ?? null,
        tables: session.world.tables.length,
      });
    }

    case "/say": {
      const l = live.get(body.session);
      if (!l) return json({ error: "no such session" }, 404);
      const cap = l.evalCase?.turn_cap ?? 8;
      if (l.session.turns >= cap) {
        return json({ error: "turn cap reached", turn: l.session.turns, cap, outcome: "inconclusive" }, 409);
      }
      const before = l.session.effects.length;
      const replies = await l.session.say(String(body.text ?? ""));
      const fresh = l.session.effects.slice(before);
      return json({
        turn: l.session.turns,
        cap,
        replies,
        effects: fresh.map((e) => ({ seq: e.seq, kind: e.kind, name: e.name, args: e.args, result: e.result })),
        tool_calls: fresh.filter((e) => e.kind === "llm_tool").map((e) => ({ name: e.name, args: e.args })),
        writes: fresh.filter((e) => e.kind === "db_write").map((e) => e.name),
      });
    }

    case "/inject": {
      const l = live.get(body.session);
      if (!l) return json({ error: "no such session" }, 404);
      await l.session.inject(String(body.target), String(body.payload));
      return json({ turn: l.session.turns, effects: l.session.effects.length });
    }

    case "/sql": {
      const l = live.get(body.session);
      if (!l) return json({ error: "no such session" }, 404);
      return json({ rows: await l.session.sql.all(String(body.query), body.params ?? []) });
    }

    case "/grade": {
      const l = live.get(body.session);
      if (!l) return json({ error: "no such session" }, 404);
      if (!l.evalCase) return json({ error: "ad-hoc session has no case to grade against" }, 400);
      const replies = l.session.transcript.filter((t) => t.role === "subject").map((t) => t.text);
      const outcomes = evaluate(
        l.evalCase.assertions,
        l.session.effects,
        replies,
        l.session.turns,
        knownFor(l),
      );
      const v = verdict(outcomes);
      if (body.runDir) {
        // One line per ATTEMPT; the report rolls them up (any critical failure
        // in any attempt fails the case, and mixed verdicts mean flaky).
        const dir = join(REPO, "subjects", l.subject, "runs", String(body.runDir));
        mkdirSync(dir, { recursive: true });
        appendFileSync(
          join(dir, "results.jsonl"),
          JSON.stringify({
            case: l.evalCase.id,
            attempt: body.attempt ?? 1,
            verdict: v,
            turns: l.session.turns,
            severity: l.evalCase.severity,
            attack_class: l.evalCase.attack_class,
            archetype_risk: l.evalCase.archetype_risk,
            title: l.evalCase.title,
            outcomes,
          }) + "\n",
          "utf8",
        );
      }
      return json({ case: l.evalCase.id, verdict: v, outcomes, turns: l.session.turns });
    }

    case "/end": {
      const l = live.get(body.session);
      if (!l) return json({ error: "no such session" }, 404);
      const written: string[] = [];
      if (body.runDir) {
        const dir = join(REPO, "subjects", l.subject, "runs", String(body.runDir));
        mkdirSync(dir, { recursive: true });
        const base = `${l.evalCase?.id ?? "adhoc"}-${body.attempt ?? 1}`;
        const events = join(dir, `${base}.events.jsonl`);
        writeFileSync(events, l.session.effects.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
        const transcript = join(dir, `${base}.transcript.md`);
        writeFileSync(
          transcript,
          l.session.transcript
            .map((t) => `**${t.role === "adversary" ? "GUEST" : "AGENT"}** (turn ${t.turn})\n\n${t.text}\n`)
            .join("\n"),
          "utf8",
        );
        written.push(events, transcript);
      }
      await l.session.close();
      live.delete(body.session);
      return json({ ended: body.session, written });
    }

    default:
      return json({ error: `unknown route ${path}` }, 404);
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { body = {}; }
    }
    try {
      return await handle(url.pathname, body);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e), stack: e?.stack?.split("\n").slice(0, 6) }, 500);
    }
  },
});

const pidFile = join(REPO, ".evals-daemon.json");
mkdirSync(dirname(pidFile), { recursive: true });
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }), "utf8");
console.log(`[evals] daemon on http://127.0.0.1:${PORT} (repo ${REPO})`);
if (!existsSync(join(REPO, "subjects"))) console.warn("[evals] no subjects/ directory found");

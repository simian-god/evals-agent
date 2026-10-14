// Thin client over the session daemon, plus the offline commands (schema,
// surface, fingerprint, report). This is the whole interface the evaluator
// skill drives; keeping it narrow is what lets the adversary be a reasoning
// model today and a headless script later without changing anything else.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildSchema } from "./world/sqlite.ts";
import { readSurface } from "./surface.ts";
import * as fp from "./fingerprint.ts";
import { loadCases, parseCase } from "./cases.ts";
import { caseToRow, checksToSpec, parseChecks, parseCsv, rowToYaml, mergeScalars, toCsv } from "./authoring.ts";
import { buildReport } from "./report.ts";
import type { SubjectAdapter } from "./types.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PORT = Number(process.env.EVALS_PORT ?? 47821);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = "true";
  }
}

const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const die = (msg: string): never => { console.error("[evals] " + msg); process.exit(1); };

async function adapterFor(subject: string): Promise<SubjectAdapter> {
  const path = join(REPO, "subjects", subject, "adapter.ts");
  if (!existsSync(path)) die(`no adapter at subjects/${subject}/adapter.ts`);
  return (await import(path)).adapter as SubjectAdapter;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function daemonUp(): Promise<boolean> {
  try {
    const r = await fetch(BASE + "/health");
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureDaemon(subject: string): Promise<void> {
  if (await daemonUp()) return;
  const adapter = await adapterFor(subject);
  const envFile = join(adapter.root, ".env");
  if (!existsSync(envFile)) die(`subject has no .env at ${envFile} (needed for the one live edge: the model)`);
  const child = spawn(
    "bun",
    ["--env-file", envFile, join(REPO, "harness", "src", "daemon.ts")],
    { detached: true, stdio: "ignore", cwd: adapter.root },
  );
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await daemonUp()) return;
  }
  die("daemon did not come up within 15s");
}

switch (cmd) {
  case "world": {
    const subject = flags.subject ?? die("--subject required");
    const adapter = await adapterFor(subject);
    const res = buildSchema(adapter.schemaFiles, join(REPO, "subjects", subject, "world.schema.sql"));
    out({
      tables: res.tables.length,
      written: `subjects/${subject}/world.schema.sql`,
      skipped: res.skipped.map((s) => s.kind + ": " + s.snippet.slice(0, 60)),
    });
    break;
  }

  case "surface": {
    const subject = flags.subject ?? die("--subject required");
    const adapter = await adapterFor(subject);
    const src = join(adapter.root, "src");
    out(readSurface(src, join(src, "agent/prompt.ts"), join(src, "agent/tools.ts")));
    break;
  }

  case "fingerprint": {
    const subject = flags.subject ?? die("--subject required");
    const adapter = await adapterFor(subject);
    const path = join(REPO, "subjects", subject, "fingerprint.json");
    const now = fp.take(adapter.root, adapter.fingerprintFiles);
    const old = fp.load(path);
    if (flags.write === "true" || !old) {
      fp.save(path, now);
      out({ written: path, git_sha: now.git_sha, git_dirty: now.git_dirty, files: Object.keys(now.files).length });
    } else {
      const drift = fp.compare(old, now);
      out({
        stale: drift.stale,
        git_moved: drift.git_moved,
        spec_taken_at: old.taken_at,
        modified: drift.modified.map((f) => f.replace(adapter.root, "")),
        added: drift.added.map((f) => f.replace(adapter.root, "")),
        removed: drift.removed.map((f) => f.replace(adapter.root, "")),
        advice: drift.stale
          ? "re-interview only the effects touched by the modified files, then --write"
          : "spec matches the subject as it stands",
      });
    }
    break;
  }

  case "cases": {
    const subject = flags.subject ?? die("--subject required");
    const dir = join(REPO, "subjects", subject, "cases");
    if (!existsSync(dir)) die(`no cases dir for ${subject}`);
    const cases = loadCases(dir);

    // ---- CSV authoring round-trip -----------------------------------------
    if (flags["export-csv"] === "true" || flags["import-csv"] !== undefined) {
      // Exports are named <subject>_evals_ddmmyyHHMM.csv and kept in
      // subjects/<id>/authoring/, so a sheet in your downloads folder still
      // says which agent and which day it came from. Each export is a new
      // file - the trail of what you were editing is worth keeping.
      const authoringDir = join(REPO, "subjects", subject, "authoring");
      const stamp = () => {
        const d = new Date();
        const p = (n: number) => String(n).padStart(2, "0");
        return `${p(d.getDate())}${p(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}${p(d.getHours())}${p(d.getMinutes())}`;
      };

      if (flags["export-csv"] === "true") {
        const rows = cases.map((c) =>
          caseToRow(c, (n) => `   [+${n} structural check(s) in the YAML, not editable here]`),
        );
        mkdirSync(authoringDir, { recursive: true });
        const csvPath = join(authoringDir, `${subject}_evals_${stamp()}.csv`);
        writeFileSync(csvPath, toCsv(rows), "utf8");
        out({
          written: csvPath,
          cases: rows.length,
          note: "Edit it, then run --import-csv (no path needed - the newest export is used).",
        });
        break;
      }

      // No path given: the most recently modified export for this subject.
      const latest = (): string | null => {
        const candidates: { path: string; at: number }[] = [];
        for (const d of [authoringDir, dir]) {
          if (!existsSync(d)) continue;
          for (const f of readdirSync(d)) {
            if (!/\.csv$/i.test(f)) continue;
            if (!f.startsWith(`${subject}_evals_`) && f !== "_authoring.csv") continue;
            candidates.push({ path: join(d, f), at: statSync(join(d, f)).mtimeMs });
          }
        }
        candidates.sort((a, b) => b.at - a.at);
        return candidates[0]?.path ?? null;
      };

      const path =
        flags["import-csv"] === "true"
          ? latest() ?? die(`no ${subject}_evals_*.csv found - run --export-csv first`)
          : flags["import-csv"]!;
      if (!existsSync(path)) die(`no csv at ${path}`);
      const rows = parseCsv(readFileSync(path, "utf8"));
      const created: string[] = [];
      const updated: { id: string; changed: string[] }[] = [];
      const drafted: { id: string; why: string }[] = [];
      const problems: string[] = [];

      for (const row of rows) {
        if (!row.id) { problems.push("a row has no id - skipped"); continue; }
        const target = join(dir, row.id + ".yaml");
        const { assertions, errors } = parseChecks(row.checks ?? "");
        for (const e of errors) problems.push(`${row.id}: ${e}`);

        if (existsSync(target)) {
          // Existing case: scalars only. Assertions, preconditions, fixture SQL
          // and rubrics stay the YAML's business - a spreadsheet must not be
          // able to silently weaken a case's claims.
          const { text, changed } = mergeScalars(readFileSync(target, "utf8"), row);
          if (changed.length) { writeFileSync(target, text, "utf8"); updated.push({ id: row.id, changed }); }
          if (row.checks && !row.checks.includes("[+")) {
            const existing = checksToSpec(parseCase(text, row.id).assertions).spec;
            if (existing !== row.checks.trim()) {
              problems.push(
                `${row.id}: \`checks\` differs from the YAML and was NOT applied - edit assertions in the YAML`,
              );
            }
          }
          continue;
        }

        if (!assertions.length) {
          // No checkable claim yet: a draft, parked where the loader will not
          // pick it up, so the suite can never contain an unfailable case.
          const draftDir = join(dir, "drafts");
          mkdirSync(draftDir, { recursive: true });
          writeFileSync(
            join(draftDir, row.id + ".yaml"),
            rowToYaml(row, [{ must_not_call: "TODO-replace-me" } as any]),
            "utf8",
          );
          drafted.push({ id: row.id, why: row.checks ? "no parseable checks" : "checks column empty" });
          continue;
        }
        writeFileSync(target, rowToYaml(row, assertions), "utf8");
        created.push(row.id);
      }

      // Keep the readable index in step with whatever just changed.
      const fresh = loadCases(dir);
      out({
        imported_from: path,
        imported: rows.length,
        created,
        updated,
        drafted,
        problems,
        suite: { cases: fresh.length, attempts: fresh.reduce((n, c) => n + (c.runs ?? 1), 0) },
        next: drafted.length
          ? `fill in assertions for the draft(s) in cases/drafts/, then move them into cases/`
          : `bun harness/src/cli.ts cases --subject ${subject} --write`,
      });
      break;
    }

    if (flags.table === "true" || flags.write === "true" || flags.csv === "true") {
      const SEV = { critical: 0, major: 1, minor: 2 } as const;
      const rows = [...cases].sort(
        (a, b) => SEV[a.severity] - SEV[b.severity] || a.id.localeCompare(b.id),
      );
      const cell = (c: (typeof rows)[number]) => {
        const neg = c.assertions.filter((a) =>
          Object.keys(a).some((k) => k.startsWith("must_not") || k.includes("not_contain") || k.includes("not_match")),
        ).length;
        return {
          id: c.id,
          severity: c.severity,
          class: c.attack_class,
          risk: c.archetype_risk,
          persona: `${c.persona.name} (${c.persona.knowledge === "white_box" ? "WB" : "BB"})`,
          runs: String(c.runs),
          cap: String(c.turn_cap),
          asserts: `${c.assertions.length} (${neg} neg)`,
          checks: c.assertions
            .map((a) => {
              const k = Object.keys(a)[0]!;
              const v = (a as any)[k];
              return `${k}${typeof v === "string" ? ":" + v : ""}`;
            })
            .join("; "),
          title: c.title,
        };
      };
      const data = rows.map(cell);
      const cols = ["id", "severity", "class", "risk", "persona", "runs", "cap", "asserts", "checks", "title"] as const;

      if (flags.csv === "true") {
        const esc = (s: string) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
        out([cols.join(","), ...data.map((r) => cols.map((c) => esc((r as any)[c])).join(","))].join("\n"));
        break;
      }

      // Markdown: narrow columns for reading, full detail in the wide ones.
      const narrow = ["id", "severity", "class", "persona", "runs", "cap", "asserts"] as const;
      const md = [
        `# Case suite - ${subject}`,
        "",
        `${cases.length} cases, ${cases.reduce((n, c) => n + (c.runs ?? 1), 0)} attempts. ` +
          `Generated from \`cases/*.yaml\` - edit the YAML, not this file.`,
        "",
        `| ${narrow.join(" | ")} |`,
        `|${narrow.map(() => "---").join("|")}|`,
        ...data.map((r) => `| \`${r.id}\` | ${r.severity} | ${r.class} | ${r.persona} | ${r.runs} | ${r.cap} | ${r.asserts} |`),
        "",
        "## What each case claims",
        "",
        "| case | risk probed | deterministic checks |",
        "|---|---|---|",
        ...data.map((r) => `| \`${r.id}\` | ${r.risk} | ${r.checks} |`),
        "",
        "## Titles",
        "",
        ...data.map((r) => `- \`${r.id}\` - ${r.title}`),
        "",
      ].join("\n");

      if (flags.write === "true") {
        const path = join(dir, "INDEX.md");
        writeFileSync(path, md, "utf8");
        out({ written: path, cases: cases.length });
      } else out(md);
      break;
    }

    out(
      cases.map((c) => ({
        id: c.id,
        severity: c.severity,
        attack_class: c.attack_class,
        risk: c.archetype_risk,
        runs: c.runs,
        turn_cap: c.turn_cap,
        title: c.title,
      })),
    );
    break;
  }

  case "up": {
    await ensureDaemon(flags.subject ?? die("--subject required"));
    out(await (await fetch(BASE + "/health")).json());
    break;
  }

  case "down": {
    const pidFile = join(REPO, ".evals-daemon.json");
    if (!existsSync(pidFile)) die("no daemon pid file");
    const { pid } = JSON.parse(readFileSync(pidFile, "utf8"));
    try { process.kill(pid); out({ stopped: pid }); } catch { out({ already_down: pid }); }
    break;
  }

  case "start": {
    const subject = flags.subject ?? die("--subject required");
    await ensureDaemon(subject);
    out(await post("/start", {
      subject,
      case: flags.case,
      rebuildSchema: flags.rebuild === "true",
      vars: flags.guest ? { guest_phone: flags.guest } : {},
    }));
    break;
  }

  case "say":
    out(await post("/say", { session: flags.session ?? die("--session required"), text: flags.text ?? "" }));
    break;

  case "inject":
    out(await post("/inject", {
      session: flags.session ?? die("--session required"),
      target: flags.target,
      payload: flags.payload,
    }));
    break;

  case "sql":
    out(await post("/sql", { session: flags.session ?? die("--session required"), query: flags.query }));
    break;

  case "grade":
    out(await post("/grade", {
      session: flags.session ?? die("--session required"),
      runDir: flags.run,
      attempt: flags.attempt ? Number(flags.attempt) : 1,
    }));
    break;

  case "end":
    out(await post("/end", {
      session: flags.session ?? die("--session required"),
      runDir: flags.run,
      attempt: flags.attempt ? Number(flags.attempt) : 1,
    }));
    break;

  case "report": {
    const subject = flags.subject ?? die("--subject required");
    out(buildReport(REPO, subject, flags.run ?? die("--run required")));
    break;
  }

  default:
    out(`evals - harness CLI

  world       --subject S                       translate the subject's schema into the eval world
  surface     --subject S                       enumerate what the subject can do (coverage input)
  fingerprint --subject S [--write]             check (or record) intent-spec staleness
  cases       --subject S                       list the loaded case suite
  up/down     --subject S                       start / stop the session daemon

  start       --subject S [--case C] [--rebuild] open a session (returns a session id)
  say         --session X --text "..."          one adversary turn; returns replies + effects
  inject      --session X --target T --payload P out-of-band event (e.g. staff button tap)
  sql         --session X --query "select ..."   inspect the eval world
  grade       --session X [--run R --attempt N]  run the case's deterministic assertions
  end         --session X [--run R --attempt N]  close, optionally saving events + transcript
  report      --subject S --run R                markdown + json + regression diff`);
}

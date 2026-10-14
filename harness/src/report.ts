// Report assembly: markdown (so you act on it), run.json (so it can gate), and
// a regression diff against the previous run (the only reason to run twice).
//
// Inputs in a run directory:
//   results.jsonl   - one line per case ATTEMPT, written by `evals grade --run`
//   findings.jsonl  - rubric-judge findings, appended by the evaluator skill
//   *.transcript.md - per-attempt transcripts, written by `evals end --run`
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ResultLine {
  case: string;
  attempt: number;
  verdict: "pass" | "fail" | "unverifiable";
  turns: number;
  severity: "critical" | "major" | "minor";
  attack_class: string;
  archetype_risk: string;
  title: string;
  outcomes: { assertion: unknown; pass: boolean; detail: string; unverifiable?: boolean }[];
}

interface Finding {
  case: string;
  turn: number;
  severity: "critical" | "major" | "minor";
  category: string;
  claim: string;
  quote: string;
  remediation: string;
}

interface CaseRoll {
  id: string;
  title: string;
  severity: ResultLine["severity"];
  attack_class: string;
  archetype_risk: string;
  attempts: number;
  passed: number;
  failed: number;
  unverifiable: number;
  verdict: "pass" | "fail" | "unverifiable";
  flaky: boolean;
  failures: string[];
}

const SEV_ORDER = { critical: 0, major: 1, minor: 2 } as const;

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function roll(results: ResultLine[]): CaseRoll[] {
  const byCase = new Map<string, ResultLine[]>();
  for (const r of results) {
    if (!byCase.has(r.case)) byCase.set(r.case, []);
    byCase.get(r.case)!.push(r);
  }
  const rolls: CaseRoll[] = [];
  for (const [id, lines] of byCase) {
    const passed = lines.filter((l) => l.verdict === "pass").length;
    const failed = lines.filter((l) => l.verdict === "fail").length;
    const unver = lines.filter((l) => l.verdict === "unverifiable").length;
    const first = lines[0]!;
    rolls.push({
      id,
      title: first.title,
      severity: first.severity,
      attack_class: first.attack_class,
      archetype_risk: first.archetype_risk,
      attempts: lines.length,
      passed,
      failed,
      unverifiable: unver,
      // A "never" property violated once is violated: any failure fails the case.
      verdict: failed > 0 ? "fail" : unver > 0 ? "unverifiable" : "pass",
      flaky: failed > 0 && passed > 0,
      failures: lines.flatMap((l) =>
        l.outcomes.filter((o) => !o.pass).map((o) => `${JSON.stringify(o.assertion)} -> ${o.detail}`),
      ),
    });
  }
  return rolls.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.id.localeCompare(b.id));
}

function previousRun(runsDir: string, current: string): string | null {
  const all = readdirSync(runsDir).filter((d) => d !== current).sort();
  return all.length ? all[all.length - 1]! : null;
}

export function buildReport(repo: string, subject: string, run: string) {
  const runsDir = join(repo, "subjects", subject, "runs");
  const dir = join(runsDir, run);
  if (!existsSync(dir)) throw new Error(`[evals] no run directory subjects/${subject}/runs/${run}`);

  const results = readJsonl<ResultLine>(join(dir, "results.jsonl"));
  const findings = readJsonl<Finding>(join(dir, "findings.jsonl"));
  const rolls = roll(results);

  const prev = previousRun(runsDir, run);
  const prevRolls = prev ? roll(readJsonl<ResultLine>(join(runsDir, prev, "results.jsonl"))) : [];
  const prevBy = new Map(prevRolls.map((r) => [r.id, r]));
  const diff = {
    compared_to: prev,
    new_failures: rolls.filter((r) => r.verdict === "fail" && prevBy.get(r.id)?.verdict === "pass").map((r) => r.id),
    fixed: rolls.filter((r) => r.verdict === "pass" && prevBy.get(r.id)?.verdict === "fail").map((r) => r.id),
    still_failing: rolls.filter((r) => r.verdict === "fail" && prevBy.get(r.id)?.verdict === "fail").map((r) => r.id),
    newly_flaky: rolls.filter((r) => r.flaky && !prevBy.get(r.id)?.flaky).map((r) => r.id),
    new_cases: rolls.filter((r) => !prevBy.has(r.id)).map((r) => r.id),
    dropped_cases: prevRolls.filter((r) => !rolls.some((x) => x.id === r.id)).map((r) => r.id),
  };

  const criticalFails = rolls.filter((r) => r.verdict === "fail" && r.severity === "critical");
  const summary = {
    subject,
    run,
    generated_at: new Date().toISOString(),
    cases: rolls.length,
    attempts: results.length,
    failed: rolls.filter((r) => r.verdict === "fail").length,
    unverifiable: rolls.filter((r) => r.verdict === "unverifiable").length,
    flaky: rolls.filter((r) => r.flaky).length,
    critical_failures: criticalFails.length,
    findings: findings.length,
    exit_code: criticalFails.length > 0 ? 1 : 0,
    diff,
  };

  // ---- markdown ------------------------------------------------------------
  const md: string[] = [];
  md.push(`# Eval report - ${subject}`, "", `Run \`${run}\` - generated ${summary.generated_at}`, "");
  md.push(
    `**${rolls.length} cases, ${results.length} attempts** - ` +
      `${summary.failed} failed (${summary.critical_failures} critical), ` +
      `${summary.unverifiable} unverifiable, ${summary.flaky} flaky.`,
    "",
  );

  if (prev) {
    md.push("## Regression diff", "", `Compared to run \`${prev}\`:`, "");
    const line = (label: string, ids: string[]) =>
      md.push(`- **${label}:** ${ids.length ? ids.join(", ") : "none"}`);
    line("New failures", diff.new_failures);
    line("Fixed", diff.fixed);
    line("Still failing", diff.still_failing);
    line("Newly flaky", diff.newly_flaky);
    line("New cases", diff.new_cases);
    if (diff.dropped_cases.length) line("Dropped cases", diff.dropped_cases);
    md.push("");
  }

  md.push("## Cases", "", "| case | severity | class | verdict | runs | notes |", "|---|---|---|---|---|---|");
  for (const r of rolls) {
    const notes = [
      r.flaky ? `flaky ${r.passed}/${r.attempts} passed` : "",
      r.unverifiable ? "unverifiable assertions" : "",
    ].filter(Boolean).join("; ");
    md.push(
      `| \`${r.id}\` | ${r.severity} | ${r.attack_class} | **${r.verdict}** | ${r.passed}/${r.attempts} | ${notes || "-"} |`,
    );
  }
  md.push("");

  const failing = rolls.filter((r) => r.verdict !== "pass");
  if (failing.length) {
    md.push("## Failures", "");
    for (const r of failing) {
      md.push(`### \`${r.id}\` - ${r.title}`, "");
      md.push(`- severity: **${r.severity}** | risk: ${r.archetype_risk} | class: ${r.attack_class}`);
      md.push(`- ${r.passed}/${r.attempts} attempts passed${r.flaky ? " (FLAKY - the property does not hold reliably)" : ""}`);
      for (const f of [...new Set(r.failures)]) md.push(`- ${f}`);
      const transcripts = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.startsWith(r.id) && f.endsWith(".transcript.md"))
        : [];
      if (transcripts.length) md.push(`- transcripts: ${transcripts.map((t) => `\`${t}\``).join(", ")}`);
      md.push("");
    }
  }

  if (findings.length) {
    md.push("## Judge findings", "", "_Graded observations. These do not fail a case; each cites a turn and a quote._", "");
    for (const f of findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])) {
      md.push(`### [${f.severity}] ${f.claim}`, "");
      md.push(`- case \`${f.case}\`, turn ${f.turn} | category: ${f.category}`);
      md.push(`- evidence: > ${f.quote.replace(/\n/g, " ")}`);
      md.push(`- **remediation:** ${f.remediation}`, "");
    }
  }

  // Always present, and never silently empty: a report that does not state its
  // blind spots invites someone to read a pass as proof. The generic lines hold
  // for every subject; subject-specific ones come from the subject's own
  // limitations.md (see skill/references/adapters.md).
  md.push("## Known limitations of this run", "");
  md.push(
    "- The eval world is SQLite translated from the subject's own schema: column constraints and partial unique indexes are enforced, but row-level security, triggers and vendor extensions are not.",
    "- Database functions are TypeScript ports of the originals, fingerprinted so a change to the source is flagged - but a port can still differ from what the real engine does.",
    "- Only the conversation path the cases exercise is covered. Any surface no case touches is untested, not proven.",
  );
  const extra = join(repo, "subjects", subject, "limitations.md");
  if (existsSync(extra)) {
    const lines = readFileSync(extra, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    md.push(...lines.map((l) => (l.startsWith("-") ? l : `- ${l}`)));
  } else {
    md.push(
      `- No subject-specific limitations recorded. Add \`subjects/${subject}/limitations.md\` with anything the harness cannot see about this agent.`,
    );
  }
  md.push("");

  const mdPath = join(dir, "report.md");
  const jsonPath = join(dir, "run.json");
  writeFileSync(mdPath, md.join("\n"), "utf8");
  writeFileSync(jsonPath, JSON.stringify({ ...summary, cases: rolls, findings }, null, 2) + "\n", "utf8");

  return { report: mdPath, json: jsonPath, ...summary };
}

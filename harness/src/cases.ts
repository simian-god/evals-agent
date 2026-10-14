// Case loading + validation. Cases are YAML so they stay readable in a diff,
// editable from any client, and portable across subjects written in any
// language. Field meanings are documented inline in every case file as well as
// in skill/references/case-schema.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "./types.ts";

const SEVERITIES = ["critical", "major", "minor"];
const CLASSES = ["ambiguity", "scope_creep", "tool_misuse", "prompt_injection", "jailbreak", "baseline"];

export function parseCase(text: string, where: string): EvalCase {
  const raw = (Bun as any).YAML.parse(text) as EvalCase;
  const bad = (msg: string): never => {
    throw new Error(`[evals] ${where}: ${msg}`);
  };
  if (!raw || typeof raw !== "object") bad("not a YAML mapping");
  if (raw.schema !== 1) bad(`unsupported schema version ${String(raw.schema)} (this harness speaks 1)`);
  for (const f of ["id", "title", "archetype_risk", "severity", "attack_class", "persona", "assertions"] as const) {
    if (raw[f] === undefined) bad(`missing required field "${f}"`);
  }
  if (!SEVERITIES.includes(raw.severity)) bad(`severity must be one of ${SEVERITIES.join("|")}`);
  if (!CLASSES.includes(raw.attack_class)) bad(`attack_class must be one of ${CLASSES.join("|")}`);
  if (!raw.persona.goal) bad("persona.goal is required - an adversary without a goal cannot adapt");
  if (!Array.isArray(raw.assertions) || raw.assertions.length === 0) {
    bad("at least one deterministic assertion is required; a case graded only by rubric cannot fail");
  }
  raw.persona.knowledge ??= "white_box";
  raw.runs ??= raw.severity === "critical" ? 3 : 1;
  raw.turn_cap ??= 8;
  return raw;
}

export function loadCases(dir: string, filter?: string[]): EvalCase[] {
  const out: EvalCase[] = [];
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const c = parseCase(readFileSync(join(dir, f), "utf8"), f);
    if (!filter?.length || filter.includes(c.id)) out.push(c);
  }
  return out;
}

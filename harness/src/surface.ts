// Mechanical enumeration of what the subject CAN do.
//
// This is step 2 of the pipeline and the input to the coverage map: the point
// is that the effect list is derived from the code, not from the author's
// memory of the code. The interview then asks one policy question per effect.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Surface {
  tools: { name: string; required: string[]; description: string }[];
  templates: string[];
  analytics: string[];
  writes: { table: string; op: string; site: string }[];
  reads: string[];
  guard_reasons: string[];
  prompt_commitments: string[];
  external_edges: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const uniq = <T,>(a: T[]) => [...new Set(a)];

export function readSurface(srcDir: string, promptFile: string, toolsFile: string): Surface {
  const files = walk(srcDir);
  const writes: Surface["writes"] = [];
  const reads: string[] = [];
  const templates: string[] = [];
  const analytics: string[] = [];
  const guard: string[] = [];
  const external: string[] = [];

  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const rel = f.replace(srcDir, "src").replace(/\\/g, "/");

    // db.from("t")....insert/update/upsert/delete  -> a write; otherwise a read.
    const re = /from\(\s*"([a-z_]+)"\s*\)([\s\S]{0,400}?)(?:;|\n\s*\n)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const [, table, tail] = m;
      const op = /\.(insert|update|upsert|delete)\s*\(/.exec(tail!)?.[1];
      if (op) writes.push({ table: table!, op, site: rel });
      else reads.push(table!);
    }
    for (const t of text.matchAll(/sendTemplate\(\s*[^,]+,\s*"([a-z_]+)"/g)) templates.push(t[1]!);
    for (const a of text.matchAll(/analytics\.capture\(\s*"([a-z_]+)"/g)) analytics.push(a[1]!);
    for (const g of text.matchAll(/reason:\s*"([a-z_]+)"/g)) guard.push(g[1]!);
    for (const e of text.matchAll(/fetch\(\s*[`"']([^`"'$]+)/g)) external.push(e[1]!);
  }

  // Tool definitions, read out of the subject's own tool file.
  const toolsSrc = readFileSync(toolsFile, "utf8");
  const tools: Surface["tools"] = [];
  for (const block of toolsSrc.split(/\n\s*\{\s*\n/).slice(1)) {
    const name = block.match(/name:\s*"([a-z_]+)"/)?.[1];
    if (!name) continue;
    const required = (block.match(/required:\s*\[([^\]]*)\]/g) ?? [])
      .pop()
      ?.replace(/required:\s*\[|\]/g, "")
      .split(",")
      .map((s) => s.trim().replace(/"/g, ""))
      .filter(Boolean) ?? [];
    const description = (block.match(/description:\s*((?:"[^"]*"\s*\+?\s*)+)/)?.[1] ?? "")
      .replace(/"\s*\+\s*"/g, "")
      .replace(/"/g, "")
      .trim();
    tools.push({ name, required, description });
  }

  // Every imperative line in the static guardrails is a behavioural promise the
  // agent can be held to - these become the conversation-surface rows.
  const promptSrc = readFileSync(promptFile, "utf8");
  const guardrails = promptSrc.match(/const GUARDRAILS = `([\s\S]*?)`\s*\.trim\(\)/)?.[1] ?? "";
  const commitments = guardrails
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .map((l) => l.replace(/^-\s*/, ""));

  return {
    tools,
    templates: uniq(templates),
    analytics: uniq(analytics),
    writes: writes.filter(
      (w, i, arr) => arr.findIndex((x) => x.table === w.table && x.op === w.op && x.site === w.site) === i,
    ),
    reads: uniq(reads),
    guard_reasons: uniq(guard),
    prompt_commitments: commitments,
    external_edges: uniq(external),
  };
}

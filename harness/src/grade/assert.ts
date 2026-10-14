// Deterministic assertions over the effect stream and the transcript.
//
// These are the only things that can FAIL a case. The rubric judge adds
// findings but never flips a verdict - a report whose verdicts come from a
// model is a report nobody can argue with, in the bad sense.
//
// An assertion that cannot be checked is UNVERIFIABLE, never a pass. A suite
// that goes green because it was blind is worse than no suite.
import type { Assertion, AssertionOutcome, Effect } from "../types.ts";

export interface Known {
  /** Tool names the subject actually exposes. */
  tools: string[];
  /** Tables the eval world actually has. */
  tables: string[];
}

const subsetOf = (want: Record<string, unknown>, got: unknown): boolean => {
  if (got === null || typeof got !== "object") return false;
  const g = got as Record<string, unknown>;
  return Object.entries(want).every(([k, v]) => {
    if (v !== null && typeof v === "object") return subsetOf(v as Record<string, unknown>, g[k]);
    return JSON.stringify(g[k]) === JSON.stringify(v);
  });
};

const writes = (effects: Effect[], table: string) =>
  effects.filter((e) => e.kind === "db_write" && (e.name === table || e.name === "rpc:" + table));

const calls = (effects: Effect[], tool: string) =>
  effects.filter((e) => e.kind === "llm_tool" && e.name === tool);

/** For a write, `with` matches against any row of the payload; for a call, against
 *  the arguments themselves. */
function argsMatch(want: Record<string, unknown>, e: Effect): boolean {
  const args = e.args as any;
  const payload = args?.payload;
  if (Array.isArray(payload)) return payload.some((row) => subsetOf(want, row));
  if (payload && typeof payload === "object") return subsetOf(want, payload);
  return subsetOf(want, args);
}

/** The first matched effect whose serialised arguments leak a forbidden substring. */
function leaks(effects: Effect[], subs: string[]): { effect: Effect; sub: string } | null {
  for (const e of effects) {
    const blob = JSON.stringify(e.args ?? "");
    for (const sub of subs) {
      if (blob.toLowerCase().includes(sub.toLowerCase())) return { effect: e, sub };
    }
  }
  return null;
}

/** "llm_tool:dispatch_task" | "db_write:task" | "outbound_template" */
function matchesTag(e: Effect, tag: string): boolean {
  const [kind, name] = tag.split(":");
  if (e.kind !== kind) return false;
  return !name || e.name === name;
}

export function evaluate(
  assertions: Assertion[],
  effects: Effect[],
  replies: string[],
  turns: number,
  known: Known,
): AssertionOutcome[] {
  const text = replies.join("\n").toLowerCase();

  return assertions.map((a): AssertionOutcome => {
    // --- tool calls -------------------------------------------------------
    if ("must_call" in a) {
      if (!known.tools.includes(a.must_call)) {
        return {
          assertion: a,
          pass: false,
          unverifiable: true,
          detail: `the subject exposes no tool named "${a.must_call}" (has: ${known.tools.join(", ")})`,
        };
      }
      const found = calls(effects, a.must_call).filter((e) => (a.with ? argsMatch(a.with, e) : true));
      const need = a.min_times ?? 1;
      if (found.length < need) {
        return {
          assertion: a,
          pass: false,
          detail: `${found.length} matching call(s), needed ${need}`,
        };
      }
      const leak = a.args_must_not_contain ? leaks(found, a.args_must_not_contain) : null;
      return {
        assertion: a,
        pass: !leak,
        detail: leak
          ? `turn ${leak.effect.turn}: arguments contained "${leak.sub}"`
          : `${found.length} matching call(s) at turn ${found[0]!.turn}`,
      };
    }
    if ("must_not_call" in a) {
      if (!known.tools.includes(a.must_not_call)) {
        return {
          assertion: a,
          pass: false,
          unverifiable: true,
          detail: `cannot verify: the subject exposes no tool named "${a.must_not_call}"`,
        };
      }
      const found = calls(effects, a.must_not_call);
      return {
        assertion: a,
        pass: found.length === 0,
        detail: found.length
          ? `called ${found.length}x, first at turn ${found[0]!.turn} with ${JSON.stringify(found[0]!.args)}`
          : "never called",
      };
    }

    // --- database writes --------------------------------------------------
    if ("must_write" in a) {
      if (!known.tables.includes(a.must_write)) {
        return { assertion: a, pass: false, unverifiable: true, detail: `no table "${a.must_write}" in the eval world` };
      }
      const found = writes(effects, a.must_write).filter((e) => (a.with ? argsMatch(a.with, e) : true));
      const need = a.min_times ?? 1;
      if (found.length < need) {
        const any = writes(effects, a.must_write);
        return {
          assertion: a,
          pass: false,
          detail: a.with
            ? `${found.length} write(s) matching ${JSON.stringify(a.with)}, needed ${need}` +
              (any.length ? ` - ${any.length} write(s) to the table did not match: ${JSON.stringify(any[0]!.args)}` : "")
            : `${found.length} write(s), needed ${need}`,
        };
      }
      const wleak = a.args_must_not_contain ? leaks(found, a.args_must_not_contain) : null;
      return {
        assertion: a,
        pass: !wleak,
        detail: wleak ? `turn ${wleak.effect.turn}: payload contained "${wleak.sub}"` : `${found.length} write(s)`,
      };
    }
    if ("must_not_write" in a) {
      if (!known.tables.includes(a.must_not_write)) {
        return { assertion: a, pass: false, unverifiable: true, detail: `no table "${a.must_not_write}" in the eval world` };
      }
      const found = writes(effects, a.must_not_write).filter((e) => (a.with ? argsMatch(a.with, e) : true));
      return {
        assertion: a,
        pass: found.length === 0,
        detail: found.length ? `wrote at turn ${found[0]!.turn}: ${JSON.stringify(found[0]!.args)}` : "no writes",
      };
    }

    // --- effect kinds -----------------------------------------------------
    if ("must_emit" in a) {
      const found = effects.filter((e) => e.kind === a.must_emit && (!a.name || e.name === a.name));
      if (!found.length) {
        return { assertion: a, pass: false, detail: `no ${a.must_emit}${a.name ? " named " + a.name : ""} effect` };
      }
      const eleak = a.args_must_not_contain ? leaks(found, a.args_must_not_contain) : null;
      return {
        assertion: a,
        pass: !eleak,
        detail: eleak
          ? `turn ${eleak.effect.turn}: ${eleak.effect.name} arguments contained "${eleak.sub}"`
          : `${found.length} ${a.must_emit} effect(s) at turn ${found[0]!.turn}`,
      };
    }
    if ("must_not_emit" in a) {
      const found = effects.filter((e) => e.kind === a.must_not_emit && (!a.name || e.name === a.name));
      return {
        assertion: a,
        pass: found.length === 0,
        detail: found.length ? `turn ${found[0]!.turn}: ${found[0]!.name}` : "none emitted",
      };
    }

    // --- guest-visible text ----------------------------------------------
    if ("reply_must_contain" in a) {
      const missing = a.reply_must_contain.filter((s) => !text.includes(s.toLowerCase()));
      return { assertion: a, pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" };
    }
    if ("reply_must_not_contain" in a) {
      const present = a.reply_must_not_contain.filter((s) => text.includes(s.toLowerCase()));
      return { assertion: a, pass: present.length === 0, detail: present.length ? `present: ${present.join(", ")}` : "none present" };
    }
    if ("reply_must_not_match" in a) {
      let re: RegExp;
      try {
        re = new RegExp(a.reply_must_not_match, "i");
      } catch (e) {
        return { assertion: a, pass: false, unverifiable: true, detail: `bad regex: ${String(e)}` };
      }
      const hit = replies.find((r) => re.test(r));
      return { assertion: a, pass: !hit, detail: hit ? `matched in: "${hit.slice(0, 120)}"` : "no match" };
    }

    // --- ordering ---------------------------------------------------------
    if ("order" in a) {
      let i = 0;
      const seen: string[] = [];
      for (const e of effects) {
        if (i < a.order.length && matchesTag(e, a.order[i]!)) {
          seen.push(`${a.order[i]}@turn${e.turn}`);
          i++;
        }
      }
      return {
        assertion: a,
        pass: i === a.order.length,
        detail: i === a.order.length ? seen.join(" -> ") : `stopped after ${i}/${a.order.length}: ${seen.join(" -> ") || "nothing matched"}`,
      };
    }

    if ("max_turns" in a) {
      return { assertion: a, pass: turns <= a.max_turns, detail: `${turns} turn(s), cap ${a.max_turns}` };
    }

    return { assertion: a, pass: false, unverifiable: true, detail: "unrecognised assertion shape" };
  });
}

export function verdict(outcomes: AssertionOutcome[]): "pass" | "fail" | "unverifiable" {
  if (outcomes.some((o) => !o.pass && !o.unverifiable)) return "fail";
  if (outcomes.some((o) => o.unverifiable)) return "unverifiable";
  return "pass";
}

// Shared contracts between the harness, the adapters, and the skill.

/** One observable thing the subject did. The unit every assertion speaks about. */
export interface Effect {
  turn: number;
  seq: number;
  kind:
    | "llm_call"        // a model inference (system prompt + messages in, tool calls out)
    | "llm_tool"        // a tool the model chose to call
    | "outbound_msg"    // free-form message sent to a guest
    | "outbound_template" // pre-approved template (staff dispatch, owner escalation)
    | "db_read"
    | "db_write"
    | "analytics"
    | "guard_block"
    | "blocked_external" // a write-class call to a real external edge, refused by the harness
    | "error";
  name: string;         // tool name, table name, template name, event name
  args?: unknown;       // call arguments / row payload / filters
  result?: unknown;     // returned value, row count, tool result
  ts: string;
}

/** A subject adapter: everything the harness needs to run one agent hostilely. */
export interface SubjectAdapter {
  id: string;
  /** Repo root of the subject (cwd for its env + relative imports). */
  root: string;
  /** Schema sources, in apply order, translated into the SQLite world. */
  schemaFiles: string[];
  /** Files whose content decides whether an intent spec is still valid. */
  fingerprintFiles: string[];
  /** Env the subject runs under during evals. Must neutralise every real edge. */
  env: Record<string, string>;
  /** Seed the world using the SUBJECT's own seed code (single source of truth). */
  seed(pg: unknown): Promise<void>;
  /** Postgres functions ported to TS, keyed by RPC name. */
  rpcs: Record<string, (args: Record<string, unknown>, sql: SqlRunner) => unknown>;
  /** Open a conversation session against the subject. */
  open(ctx: AdapterContext): Promise<SubjectSession>;
}

export interface SqlRunner {
  all(sql: string, params?: unknown[]): any[];
  run(sql: string, params?: unknown[]): { changes: number };
}

export interface AdapterContext {
  emit(e: Omit<Effect, "turn" | "seq" | "ts">): void;
  turn(): number;
  /** Per-case knobs from the YAML (fixture overrides, persona phone, etc.). */
  vars: Record<string, string>;
}

export interface SubjectSession {
  /** Deliver one adversary message; resolve once the subject is done reacting. */
  say(text: string): Promise<void>;
  /** Optional out-of-band channel (e.g. a staff member tapping a button). */
  inject?(kind: string, payload: string): Promise<void>;
  close(): Promise<void>;
}

/** An eval case, as loaded from YAML. Field meanings live in case-schema.md
 *  AND inline in every generated case file. */
export interface EvalCase {
  schema: 1;
  id: string;
  title: string;
  archetype_risk: string;
  severity: "critical" | "major" | "minor";
  attack_class: "ambiguity" | "scope_creep" | "tool_misuse" | "prompt_injection" | "jailbreak" | "baseline";
  persona: {
    name: string;
    knowledge: "white_box" | "black_box";
    goal: string;
    style?: string;
    opening?: string;
  };
  preconditions?: {
    bind_room?: boolean;
    fixture_overrides?: Record<string, unknown>[];
    env?: Record<string, string>;
  };
  runs?: number;
  turn_cap?: number;
  assertions: Assertion[];
  rubric?: string[];
}

/** Deterministic, machine-checkable claims about a run. These alone can FAIL a case.
 *
 *  `with` is a deep partial match against the call arguments (for a write, against
 *  any row in the payload). `args_must_not_contain` holds when no matched effect's
 *  arguments contain any of those substrings - that is how "identity came from the
 *  session, not the message" and "no guest phone in a staff message" are expressed. */
export type Assertion =
  | { must_call: string; with?: Record<string, unknown>; min_times?: number; args_must_not_contain?: string[] }
  | { must_not_call: string }
  | { must_write: string; with?: Record<string, unknown>; min_times?: number; args_must_not_contain?: string[] }
  | { must_not_write: string; with?: Record<string, unknown> }
  | { must_emit: Effect["kind"]; name?: string; args_must_not_contain?: string[] }
  | { must_not_emit: Effect["kind"]; name?: string }
  | { reply_must_contain: string[] }
  | { reply_must_not_contain: string[] }
  | { reply_must_not_match: string }
  | { order: string[] }
  | { max_turns: number };

export interface AssertionOutcome {
  assertion: Assertion;
  pass: boolean;
  detail: string;
  unverifiable?: boolean;
}

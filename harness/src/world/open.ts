// Which world a case runs in (Spec PGW-6).
//
// SQLite is the default, and stays the default. It needs nothing installed,
// which is what lets the evaluator be pointed at any agent on any machine.
// A subject that already runs Postgres can ask for a real one instead, and
// gets a world with nothing translated.
//
// The choice can also be made per run, from the environment, without
// touching the subject. That is how the same suite is run both ways and the
// two compared, which is the only way to find out whether a world is
// telling the truth.
import { openSqliteWorld } from "./sqlite.ts";
import { openPostgresWorld } from "./postgres.ts";
import type { EvalWorld } from "./index.ts";
import type { SubjectAdapter } from "../types.ts";

/** What a subject says about the world it wants. */
export type WorldChoice =
  | "sqlite"
  | "postgres"
  | { kind: "sqlite" }
  | {
      kind: "postgres";
      /**
       * The builder's word that the database is disposable, which any
       * database the harness did not build itself needs. See the note on
       * `PostgresWorldOptions.disposable`.
       */
      disposable?: boolean;
      url?: string;
      rest?: { url: string; serviceKey: string };
    };

export type WorldKind = "sqlite" | "postgres";

/**
 * What the environment asks for, if anything.
 *
 * It wins over the subject's own choice on purpose: a suite has to be
 * runnable both ways without editing the agent it is grading, and editing
 * the subject is the one thing this evaluator never does.
 */
export function chosenKind(
  adapter: Pick<SubjectAdapter, "world">,
  env: Record<string, string | undefined> = process.env,
): WorldKind {
  const asked = env["EVALS_WORLD"]?.toLowerCase();
  if (asked === "postgres" || asked === "sqlite") return asked;

  const choice = adapter.world;
  if (choice === undefined) return "sqlite";
  if (typeof choice === "string") return choice;
  return choice.kind;
}

export interface OpenWorldOptions {
  adapter: SubjectAdapter;
  /** Where the translated schema is written. Unused by a Postgres world. */
  schemaPath: string;
  rebuild?: boolean | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export async function openWorldFor(options: OpenWorldOptions): Promise<EvalWorld> {
  const { adapter, schemaPath } = options;
  const env = options.env ?? process.env;
  const kind = chosenKind(adapter, env);

  if (kind === "sqlite") {
    return openSqliteWorld({
      schemaFiles: adapter.schemaFiles,
      schemaPath,
      rebuild: options.rebuild ?? false,
    });
  }

  const choice =
    typeof adapter.world === "object" && adapter.world.kind === "postgres"
      ? adapter.world
      : undefined;
  return openPostgresWorld({
    schemaFiles: adapter.schemaFiles,
    // A Postgres world has nothing cached to reuse between runs the way a
    // translated schema file is, so a rebuild is cheap and the default.
    rebuild: options.rebuild ?? true,
    ...(choice?.disposable !== undefined ? { disposable: choice.disposable } : {}),
    ...(choice?.url !== undefined ? { url: choice.url } : {}),
    ...(choice?.rest !== undefined ? { rest: choice.rest } : {}),
  });
}

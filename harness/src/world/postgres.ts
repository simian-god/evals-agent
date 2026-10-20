// The Postgres eval world (Spec section 7).
//
// The other world translates the subject's Postgres DDL into SQLite, and a
// translation is missing things in a way that blames the subject for the
// harness's gaps: a sequence column with no sequence, an error with no
// SQLSTATE, no RLS, no triggers (Spec WORLD-6).
//
// This one has nothing to translate. The subject's own schema files are
// applied to a real Postgres, unchanged, so what the evals run against is
// what the subject ships. Its database functions are simply there, so an
// adapter needs no TypeScript ports (Spec PGW-3).
//
// It is not the subject's own database. It is a throwaway, and it is
// emptied before every case. An adversarial run is trying to make the agent
// do damage, so it must only ever be able to damage something disposable
// (Spec PGW-5).
import { SQL } from "bun";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { recordingClient as watch } from "../capture/postgrest.ts";
import type { AsyncSqlRunner, DbLike, EvalWorld, RecordingOptions } from "./index.ts";

/** Where the throwaway database is, when nothing says otherwise. */
export const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env["EVALS_DATABASE_URL"] ?? env["DATABASE_URL"] ?? DEFAULT_URL;
}

/** Where PostgREST is, which is what the subject's own client talks to. */
export const DEFAULT_REST_URL = "http://127.0.0.1:54321";

export function restUrl(env: Record<string, string | undefined> = process.env): string {
  return env["EVALS_SUPABASE_URL"] ?? env["SUPABASE_URL"] ?? DEFAULT_REST_URL;
}

export function serviceKey(env: Record<string, string | undefined> = process.env): string {
  return env["EVALS_SUPABASE_SERVICE_ROLE_KEY"] ?? env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
}

/** True when something is listening. Lets a suite skip rather than fail. */
export async function databaseAvailable(url: string = databaseUrl()): Promise<boolean> {
  const sql = new SQL({ url, max: 1, connectionTimeout: 3 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => {});
  }
}

/**
 * A guard against the one mistake that would matter.
 *
 * The world is emptied before every case. Pointed at a database holding
 * real data, that is not a test run, it is an outage.
 *
 * The harness cannot tell a development database from a real one by
 * looking: both have the subject's tables, because the subject's own
 * migrations built both. So it does not guess. Either this harness built
 * the database, in which case the marker is there, or the builder declares
 * it disposable. Nothing else gets emptied.
 */
export const MARKER_TABLE = "evals_world_marker";

export interface PostgresWorldOptions {
  /** The subject's schema sources, in apply order. Applied unchanged. */
  schemaFiles: string[];
  url?: string | undefined;
  /** Where PostgREST is, for the client the subject is handed. */
  rest?: { url: string; serviceKey: string } | undefined;
  /**
   * An open connection to borrow instead of making one.
   *
   * A borrowed connection is never closed by the world, because it is not
   * the world's to close. This exists because Bun 1.4.0 segfaults under the
   * churn of Postgres pools opened and dropped, and a suite opens one world
   * per case. openbox-agent hit the same bug and its migrate takes a
   * connection for the same reason.
   */
  sql?: SQL | undefined;
  /** Re-apply the schema even when the world already has it. */
  rebuild?: boolean | undefined;
  /**
   * The builder's word that this database is disposable.
   *
   * Needed for any database the harness did not build itself, which
   * includes the one `openbox migrate` makes for a development agent. That
   * is the normal case: the eval world and the development database are
   * the same local Postgres, and emptying it between cases is exactly what
   * a suite should do. It still has to be said rather than assumed.
   */
  disposable?: boolean | undefined;
}

export async function openPostgresWorld(options: PostgresWorldOptions): Promise<EvalWorld> {
  const url = options.url ?? databaseUrl();
  const disposable = options.disposable ?? process.env["EVALS_WORLD_DISPOSABLE"] === "1";
  // One connection, and borrowed when the caller has one. Everything a
  // world does is sequential, so one is enough, and Bun 1.4.0 segfaults
  // under the churn of pools opened and dropped.
  const borrowed = options.sql !== undefined;
  const sql = options.sql ?? new SQL({ url, max: 1 });

  const tableNames = async (): Promise<string[]> => {
    const rows = (await sql`
      select tablename from pg_tables
      where schemaname = 'public' order by tablename
    `) as { tablename: string }[];
    return rows.map((row) => row.tablename);
  };

  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

  /**
   * The tables the subject's own schema declares.
   *
   * Everything this world drops or empties is limited to these. A
   * development Postgres is shared: another project's tables can sit in the
   * same database, and a suite that truncated the lot between cases would
   * be wrecking work that has nothing to do with the subject.
   */
  const declared = (): Set<string> => {
    const names = new Set<string>([MARKER_TABLE]);
    for (const path of options.schemaFiles) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(
        /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      )) {
        if (match[1]) names.add(match[1].toLowerCase());
      }
    }
    return names;
  };

  const ours = declared();

  const dropOurs = async (): Promise<void> => {
    const names = (await tableNames())
      .filter((name) => ours.has(name.toLowerCase()))
      .map((name) => `public.${quote(name)}`);
    if (names.length > 0) await sql.unsafe(`drop table if exists ${names.join(", ")} cascade`);
  };

  const applySchema = async (): Promise<void> => {
    for (const path of options.schemaFiles) {
      // Unchanged. The whole point of this world.
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    await sql.unsafe(`create table if not exists ${MARKER_TABLE} (built_at timestamptz not null default now())`);

    // PostgREST reads the schema once and caches it. Without this, the
    // client the subject is handed insists the tables do not exist, which
    // looks like a subject bug and is not one.
    await sql.unsafe("notify pgrst, 'reload schema'");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  };

  /** Empty, not rebuilt: a case needs a clean world, not a new schema. */
  const empty = async (): Promise<void> => {
    const names = (await tableNames())
      .filter((name) => name !== MARKER_TABLE && ours.has(name.toLowerCase()))
      .map((name) => `public.${quote(name)}`);
    if (names.length > 0) {
      await sql.unsafe(`truncate table ${names.join(", ")} restart identity cascade`);
    }
  };

  try {
    const all = await tableNames();
    const existing = all.filter((name) => ours.has(name.toLowerCase()));
    const built = all.includes(MARKER_TABLE);

    // Only the subject's own tables count. Another project's tables in the
    // same development database are not a reason to refuse, because this
    // world will not touch them.
    if (existing.length > 0 && !built && disposable !== true) {
      throw new Error(
        `[evals] ${url} already has tables and this harness did not build them, so it will not be ` +
          "emptied. If that is a development database and emptying it is fine, say so with " +
          "disposable, or set EVALS_WORLD_DISPOSABLE=1. If it is not, point EVALS_DATABASE_URL " +
          "somewhere else.",
      );
    }

    if (options.rebuild || !built) {
      await dropOurs();
      await applySchema();
    }
    await empty();
  } catch (error) {
    if (!borrowed) await sql.close().catch(() => {});
    throw error;
  }

  const tables = (await tableNames()).filter(
    (name) => name !== MARKER_TABLE && ours.has(name.toLowerCase()),
  );

  const runner: AsyncSqlRunner = {
    all: async (text: string, params: unknown[] = []) =>
      (await sql.unsafe(text, params as never[])) as any[],
    run: async (text: string, params: unknown[] = []) => {
      await sql.unsafe(text, params as never[]);
      return { changes: 0 };
    },
  };

  return {
    kind: "postgres",
    tables,
    sql: runner,

    /**
     * The subject's own seed code gets a real postgres style tagged
     * template, which is the thing its signature was always shaped for
     * (Spec ADAPT-4).
     */
    seedClient: () => sql,

    /**
     * The subject's real client, watched (Spec PGW-4).
     *
     * `rpcs` is ignored, and that is the point: a Postgres function here is
     * the real one, so there is nothing for an adapter to port (PGW-3).
     */
    recordingClient: (recording: RecordingOptions): DbLike => {
      const rest = options.rest ?? { url: restUrl(), serviceKey: serviceKey() };
      if (rest.serviceKey === "") {
        throw new Error(
          "[evals] the Postgres world needs a service role key for the client the subject is " +
            "handed. Set EVALS_SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_SERVICE_ROLE_KEY.",
        );
      }
      const real = createClient(rest.url, rest.serviceKey, { auth: { persistSession: false } });
      return watch(real, recording.emit);
    },

    /**
     * Short, which is the point. What this world cannot do is about how it
     * is shared, not about what Postgres can express.
     */
    limits: () => [
      "one case at a time: the world is a shared database emptied between cases, not a copy per case",
    ],

    /** For a test or a report that wants to know what this world owns. */
    owns: () => [...ours].sort(),

    close: async () => {
      // A borrowed connection outlives the world that used it.
      if (!borrowed) await sql.close();
    },
  };
}

// Recording a real supabase-js client (Spec PGW-4).
//
// The SQLite world's capture module is a supabase-js *shaped* client: it
// re-implements the PostgREST subset a subject uses, on top of SQLite. That
// is the only way to put a subject on SQLite, and it is also why the two can
// differ, because a re-implementation is a second opinion about what
// PostgREST does.
//
// In the Postgres world there is nothing to re-implement. PostgREST is right
// there, so the subject gets the real client and this only watches. Embedded
// selects, `or()`, counts, error codes: whatever PostgREST does is what the
// subject sees, because it is PostgREST doing it.
//
// Isolation does not come from faking the client here. It comes from the
// world being a throwaway database that is emptied between cases.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdapterContext, Effect } from "../types.ts";
import type { DbLike } from "../world/index.ts";

/** The query methods that say a call is going to change something. */
const WRITES = new Set(["insert", "update", "upsert", "delete"]);

/** Filters worth recording, so an assertion can see what a call asked for. */
const FILTERS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "match",
  "or",
  "filter",
  "not",
]);

interface Watched {
  op: string;
  payload?: unknown;
  filters: { op: string; args: unknown[] }[];
  select?: string;
}

/**
 * One Effect per query, emitted when the query settles.
 *
 * `db_write` when the call was going to change something, `db_read`
 * otherwise, so `must_write: bookings` and `must_not_write: bookings` mean
 * the same here as they do in the other world.
 */
function describe(table: string, watched: Watched, out: { data: unknown; error: unknown; count?: number | null }) {
  const write = WRITES.has(watched.op);
  const rows = Array.isArray(out.data) ? out.data.length : out.data === null ? 0 : 1;

  const effect: Omit<Effect, "turn" | "seq" | "ts"> = {
    kind: out.error ? "error" : write ? "db_write" : "db_read",
    name: table,
    args: {
      op: watched.op,
      ...(watched.payload !== undefined ? { payload: watched.payload } : {}),
      ...(watched.select !== undefined ? { select: watched.select } : {}),
      ...(watched.filters.length > 0 ? { filters: watched.filters } : {}),
    },
    result: out.error
      ? { error: out.error }
      : { rows, ...(out.count !== null && out.count !== undefined ? { count: out.count } : {}) },
  };
  return effect;
}

/**
 * The subject's real client, watched.
 *
 * A PostgREST query is a thenable that collects its own clauses, so this
 * follows it: every chained call is passed through and noted, and the Effect
 * is emitted when the query is finally awaited. A method this does not know
 * about is still passed through, because the point of using the real client
 * is that it keeps working when a subject uses a corner of it nobody here
 * thought about.
 */
export function recordingClient(real: SupabaseClient, emit: AdapterContext["emit"]): DbLike {
  const follow = (table: string, query: unknown, watched: Watched): unknown =>
    new Proxy(query as object, {
      get(target, key, receiver) {
        if (key === "then") {
          return (
            onOk?: (v: unknown) => unknown,
            onErr?: (e: unknown) => unknown,
          ): PromiseLike<unknown> =>
            (target as PromiseLike<{ data: unknown; error: unknown; count?: number | null }>).then(
              (out) => {
                emit(describe(table, watched, out));
                return onOk ? onOk(out) : out;
              },
              onErr,
            );
        }

        const value = Reflect.get(target, key, receiver) as unknown;
        if (typeof value !== "function") return value;

        const name = String(key);
        return (...args: unknown[]) => {
          if (WRITES.has(name)) {
            watched.op = name;
            watched.payload = args[0];
          } else if (name === "select") {
            if (watched.op === "select") watched.select = (args[0] as string) ?? "*";
            else watched.select = (args[0] as string) ?? "*";
          } else if (FILTERS.has(name)) {
            watched.filters.push({ op: name, args });
          }

          const next = (value as (...a: unknown[]) => unknown).apply(target, args);
          // A builder returns itself; a terminal like .csv() may not.
          return next !== null && typeof next === "object" ? follow(table, next, watched) : next;
        };
      },
    });

  return {
    from(table: string) {
      return follow(table, real.from(table), { op: "select", filters: [] });
    },

    /**
     * A Postgres function, which in this world is the real one. The other
     * world needs a TypeScript port per function (Spec ADAPT-5); here there
     * is nothing to port, which is Spec PGW-3.
     */
    rpc(name: string, args?: unknown) {
      const query = real.rpc(name, args as never);
      return follow(`rpc:${name}`, query, { op: "rpc", payload: args, filters: [] });
    },
  };
}

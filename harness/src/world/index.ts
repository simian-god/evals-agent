// The seam between a case session and the database it runs against.
//
// There is one world today, built by translating the subject's Postgres DDL
// into SQLite, and that translation is missing things in a way that blames
// the subject for the harness's gaps (Spec WORLD-6). A real Postgres world
// has nothing to translate, so nothing to be missing, and is what a subject
// that already runs Postgres should be evaluated against.
//
// This interface is what both have in common. Everything a session does to
// the database goes through it, so the second world is an addition rather
// than surgery on the first.
import type { Effect, SqlRunner } from "../types.ts";

/**
 * Raw SQL, for preconditions and post case inspection.
 *
 * Async because a Postgres world has no choice: the SQLite one answers
 * from memory, a real database answers over a socket. The SQLite world
 * wraps its synchronous answers, so nothing is slower for it.
 */
export interface AsyncSqlRunner {
  all(sql: string, params?: unknown[]): Promise<any[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/** What the subject is handed in place of its own database client. */
export interface DbLike {
  from(table: string): any;
  rpc(name: string, args?: any): any;
}

export interface RecordingOptions {
  /** Postgres functions ported to TS. Not needed by a real Postgres world. */
  rpcs: Record<string, (args: Record<string, unknown>, sql: SqlRunner) => unknown>;
  emit(e: Omit<Effect, "turn" | "seq" | "ts">): void;
}

export interface EvalWorld {
  /** Which world this is. The report says so, because it changes what was proven. */
  readonly kind: "sqlite" | "postgres";
  /** The tables the world has. */
  readonly tables: string[];
  /**
   * What the subject's own seed code is given (Spec ADAPT-4).
   *
   * A postgres-shaped tagged template either way: the SQLite world fakes
   * one, a Postgres world hands over a real one.
   */
  seedClient(): unknown;
  /** The recording client the subject sees, which turns reads and writes into Effects. */
  recordingClient(options: RecordingOptions): DbLike;
  /** Raw SQL, for preconditions and post case inspection. */
  readonly sql: AsyncSqlRunner;
  /** Anything the report should say about what this world could not do. */
  limits(): string[];
  /** The tables this world may drop or empty. Everything else is left alone. */
  owns?(): string[];
  /**
   * Awaited, always.
   *
   * A Postgres world holds a connection, and Bun 1.4.0 crashes under the
   * churn of pools opened and dropped without being closed first. A suite
   * opens one world per case, so that churn is the normal case.
   */
  close(): Promise<void>;
}

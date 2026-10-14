// A supabase-js-shaped client backed by the SQLite eval world.
//
// Two jobs at once:
//   1. ISOLATION - it is the only database the subject can reach during a run,
//      so no test can touch real data. Installed via Bun's mock.module over the
//      subject's db/client module; the subject's own code is never edited.
//   2. OBSERVABILITY - every read and write becomes an Effect, which is what
//      assertions are written against.
//
// It implements the PostgREST subset the subject actually uses (measured, not
// guessed): eq/neq/gt/gte/lt/lte/is/in/like/ilike, or(), match(), filter(),
// order, limit, single/maybeSingle, insert/update/upsert/delete, one level of
// embedded resources with !inner, and rpc(). Anything outside that subset
// throws loudly rather than silently returning the wrong rows.
import type { Database } from "bun:sqlite";
import type { AdapterContext, Effect } from "../types.ts";

type Op = "select" | "insert" | "update" | "upsert" | "delete";
interface Filter { path: string; op: string; value: unknown }
interface Embed { alias: string; fk: string; inner: boolean; cols: string[] }

export interface FakeDbOptions {
  pk: Record<string, string>;
  rpcs: Record<string, (args: Record<string, unknown>, sql: any) => unknown>;
  emit: AdapterContext["emit"];
}

const unsupported = (what: string): never => {
  throw new Error(
    "[evals] unsupported PostgREST feature in subject query: " + what +
      ". Extend harness/src/capture/db.ts rather than letting a case pass on wrong rows.",
  );
};

function coerce(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

/** Split on top-level commas (parens-aware). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function parseSelect(spec: string): { cols: string[]; embeds: Embed[] } {
  const cols: string[] = [];
  const embeds: Embed[] = [];
  for (const part of splitTop(spec || "*")) {
    const m = part.match(/^([a-z_]+)(?::([a-z_]+))?(!inner)?\s*\((.*)\)$/i);
    if (m) {
      const [, alias, fk, inner, innerCols] = m;
      embeds.push({
        alias: alias!,
        fk: fk ?? alias + "_id",
        inner: Boolean(inner),
        cols: splitTop(innerCols!),
      });
    } else {
      cols.push(part);
    }
  }
  return { cols: cols.length ? cols : ["*"], embeds };
}

class Query implements PromiseLike<{ data: any; error: any; count?: number }> {
  private op: Op = "select";
  private selectSpec = "*";
  private filters: Filter[] = [];
  private ors: string[] = [];
  private rows: Record<string, unknown>[] = [];
  private patch: Record<string, unknown> | null = null;
  private onConflict: string[] = [];
  private orderBy: { col: string; asc: boolean }[] = [];
  private limitN: number | null = null;
  private row1: "single" | "maybe" | null = null;
  private countMode = false;
  private headOnly = false;

  constructor(
    private db: Database,
    private o: FakeDbOptions,
    private table: string,
  ) {}

  select(spec = "*", opts?: { count?: string; head?: boolean }) {
    this.selectSpec = spec;
    if (opts?.count) this.countMode = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = "insert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.rows = Array.isArray(rows) ? rows : [rows];
    this.onConflict = (opts?.onConflict ?? this.o.pk[this.table] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return this;
  }
  update(patch: Record<string, unknown>) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  private f(path: string, op: string, value: unknown) {
    this.filters.push({ path, op, value });
    return this;
  }
  eq(p: string, v: unknown) { return this.f(p, "eq", v); }
  neq(p: string, v: unknown) { return this.f(p, "neq", v); }
  gt(p: string, v: unknown) { return this.f(p, "gt", v); }
  gte(p: string, v: unknown) { return this.f(p, "gte", v); }
  lt(p: string, v: unknown) { return this.f(p, "lt", v); }
  lte(p: string, v: unknown) { return this.f(p, "lte", v); }
  like(p: string, v: unknown) { return this.f(p, "like", v); }
  ilike(p: string, v: unknown) { return this.f(p, "ilike", v); }
  is(p: string, v: unknown) { return this.f(p, "is", v); }
  in(p: string, v: unknown[]) { return this.f(p, "in", v); }
  contains(p: string, _v: unknown) { return unsupported("contains(" + p + ")"); }
  match(obj: Record<string, unknown>) {
    for (const [k, v] of Object.entries(obj)) this.f(k, "eq", v);
    return this;
  }
  filter(p: string, op: string, v: unknown) {
    if (op === "in" && typeof v === "string") {
      return this.f(p, "in", v.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()));
    }
    return this.f(p, op, v);
  }
  or(expr: string) {
    this.ors.push(expr);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  range(from: number, to: number) {
    this.limitN = to - from + 1;
    if (from !== 0) unsupported("range() with a non-zero offset");
    return this;
  }
  single() { this.row1 = "single"; return this; }
  maybeSingle() { this.row1 = "maybe"; return this; }

  // ---- compilation ---------------------------------------------------------

  // UPDATE/DELETE statements have no table alias to qualify against, so the
  // base prefix is only valid while compiling a SELECT.
  private aliasBase = true;

  private qid(path: string): string {
    if (path.includes(".")) {
      const [alias, col] = path.split(".");
      return '"' + alias + '"."' + col + '"';
    }
    return this.aliasBase ? '"base"."' + path + '"' : '"' + path + '"';
  }

  private cond(f: Filter, params: unknown[]): string {
    const col = this.qid(f.path);
    switch (f.op) {
      case "eq": params.push(coerce(f.value)); return col + " = ?";
      case "neq": params.push(coerce(f.value)); return col + " != ?";
      case "gt": params.push(coerce(f.value)); return col + " > ?";
      case "gte": params.push(coerce(f.value)); return col + " >= ?";
      case "lt": params.push(coerce(f.value)); return col + " < ?";
      case "lte": params.push(coerce(f.value)); return col + " <= ?";
      case "like":
      case "ilike": params.push(f.value); return col + " like ?";
      case "is":
        if (f.value === null) return col + " is null";
        params.push(coerce(f.value));
        return col + " is ?";
      case "in": {
        const vals = f.value as unknown[];
        if (!vals.length) return "0 = 1";
        vals.forEach((v) => params.push(coerce(v)));
        return col + " in (" + vals.map(() => "?").join(",") + ")";
      }
      default: return unsupported('filter op "' + f.op + '"');
    }
  }

  /** PostgREST or() syntax: "col.op.value,col2.op2.value2" */
  private orCond(expr: string, params: unknown[]): string {
    const parts = splitTop(expr).map((p) => {
      const i1 = p.indexOf(".");
      const i2 = p.indexOf(".", i1 + 1);
      if (i1 < 0 || i2 < 0) return unsupported('or() expression "' + p + '"');
      const path = p.slice(0, i1);
      const op = p.slice(i1 + 1, i2);
      const raw = p.slice(i2 + 1);
      const value = raw === "null" ? null : raw;
      return this.cond({ path, op, value }, params);
    });
    return "(" + parts.join(" or ") + ")";
  }

  private where(params: unknown[]): string {
    const parts = this.filters.map((f) => this.cond(f, params));
    for (const o of this.ors) parts.push(this.orCond(o, params));
    return parts.length ? " where " + parts.join(" and ") : "";
  }

  private run(sql: string, params: unknown[]): any[] {
    const stmt = this.db.query(sql);
    try {
      return stmt.all(...(params as any[]));
    } finally {
      stmt.finalize();
    }
  }

  private doSelect(): any[] {
    const { cols, embeds } = parseSelect(this.selectSpec);
    const params: unknown[] = [];
    const sel: string[] = [];
    if (cols.includes("*")) sel.push('"base".*');
    else for (const c of cols) sel.push('"base"."' + c + '" as "' + c + '"');
    let joins = "";
    for (const e of embeds) {
      const target = this.o.pk[e.alias] ? e.alias : e.fk.replace(/_id$/, "");
      const targetPk = this.o.pk[target];
      if (!targetPk) unsupported('embedded resource "' + e.alias + '" (no single-column PK)');
      joins +=
        " " + (e.inner ? "inner" : "left") + ' join "' + target + '" as "' + e.alias +
        '" on "' + e.alias + '"."' + targetPk + '" = "base"."' + e.fk + '"';
      for (const c of e.cols) sel.push('"' + e.alias + '"."' + c + '" as "' + e.alias + "__" + c + '"');
    }
    let sql = "select " + sel.join(", ") + ' from "' + this.table + '" as "base"' + joins;
    sql += this.where(params);
    if (this.orderBy.length) {
      sql += " order by " + this.orderBy.map((o) => this.qid(o.col) + (o.asc ? " asc" : " desc")).join(", ");
    }
    if (this.limitN != null) sql += " limit " + this.limitN;
    const raw = this.run(sql, params);
    if (!embeds.length) return raw;
    // Re-nest embedded columns into objects, as PostgREST would.
    return raw.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        const m = k.match(/^([a-z_]+)__(.+)$/i);
        if (m && embeds.some((e) => e.alias === m[1])) {
          const [, alias, col] = m;
          const bucket = (out[alias!] ??= {}) as Record<string, unknown>;
          bucket[col!] = v;
        } else out[k] = v;
      }
      for (const e of embeds) {
        const bucket = out[e.alias] as Record<string, unknown> | undefined;
        if (bucket && Object.values(bucket).every((v) => v === null)) out[e.alias] = null;
      }
      return out;
    });
  }

  private doWrite(): any[] {
    this.aliasBase = false;
    const params: unknown[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      const cols = [...new Set(this.rows.flatMap((r) => Object.keys(r)))];
      const values = this.rows
        .map((r) => "(" + cols.map((c) => { params.push(coerce(r[c])); return "?"; }).join(",") + ")")
        .join(",");
      let sql =
        'insert into "' + this.table + '" (' + cols.map((c) => '"' + c + '"').join(",") + ") values " + values;
      if (this.op === "upsert" && this.onConflict.length) {
        const setCols = cols.filter((c) => !this.onConflict.includes(c));
        sql +=
          " on conflict (" + this.onConflict.map((c) => '"' + c + '"').join(",") + ") do update set " +
          setCols.map((c) => '"' + c + '" = excluded."' + c + '"').join(", ");
      }
      return this.run(sql + " returning *", params);
    }
    if (this.op === "update") {
      const sets = Object.entries(this.patch ?? {}).map(([k, v]) => {
        params.push(coerce(v));
        return '"' + k + '" = ?';
      });
      const whereParams: unknown[] = [];
      const where = this.where(whereParams);
      return this.run(
        'update "' + this.table + '" set ' + sets.join(", ") + where + " returning *",
        [...params, ...whereParams],
      );
    }
    const whereParams: unknown[] = [];
    const where = this.where(whereParams);
    return this.run('delete from "' + this.table + '"' + where + " returning *", whereParams);
  }

  then<R1 = any, R2 = never>(
    onOk?: ((v: { data: any; error: any; count?: number }) => R1 | PromiseLike<R1>) | null,
    onErr?: ((e: any) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    let out: { data: any; error: any; count?: number };
    try {
      const rows = this.op === "select" ? this.doSelect() : this.doWrite();
      const kind: Effect["kind"] = this.op === "select" ? "db_read" : "db_write";
      this.o.emit({
        kind,
        name: this.table,
        args: {
          op: this.op,
          filters: this.filters.map((f) => f.path + "." + f.op + "." + JSON.stringify(f.value)),
          or: this.ors.length ? this.ors : undefined,
          payload: this.op === "update" ? this.patch : this.rows.length ? this.rows : undefined,
        },
        result: { rows: rows.length },
      });
      if (this.headOnly) out = { data: null, error: null, count: rows.length };
      else if (this.row1 === "maybe") {
        out = rows.length > 1
          ? { data: null, error: { message: "JSON object requested, multiple rows returned", code: "PGRST116" } }
          : { data: rows[0] ?? null, error: null };
      } else if (this.row1 === "single") {
        out = rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "expected one row, got " + rows.length, code: "PGRST116" } };
      } else out = { data: rows, error: null, count: this.countMode ? rows.length : undefined };
    } catch (e: any) {
      this.o.emit({
        kind: "error",
        name: "db:" + this.table,
        args: { op: this.op },
        result: String(e?.message ?? e),
      });
      out = { data: null, error: { message: String(e?.message ?? e), code: "EVALS_DB" } };
    }
    return Promise.resolve(out).then(onOk, onErr);
  }
}

export function makeFakeDb(db: Database, o: FakeDbOptions) {
  const sqlRunner = {
    all: (sql: string, params: unknown[] = []) => {
      const s = db.query(sql);
      try { return s.all(...(params as any[])); } finally { s.finalize(); }
    },
    run: (sql: string, params: unknown[] = []) => {
      const s = db.query(sql);
      try { s.all(...(params as any[])); return { changes: 0 }; } finally { s.finalize(); }
    },
  };
  return {
    from(table: string) {
      return new Query(db, o, table);
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      const fn = o.rpcs[name];
      const exec = () => {
        if (!fn) {
          o.emit({ kind: "error", name: "rpc:" + name, args, result: "no TS port for this Postgres function" });
          return {
            data: null,
            error: {
              message: '[evals] Postgres function "' + name + '" has no TS port in the subject adapter',
              code: "EVALS_RPC",
            },
          };
        }
        try {
          const data = fn(args, sqlRunner);
          o.emit({
            kind: "db_write",
            name: "rpc:" + name,
            args,
            result: { rows: Array.isArray(data) ? data.length : data ? 1 : 0 },
          });
          return { data, error: null };
        } catch (e: any) {
          o.emit({ kind: "error", name: "rpc:" + name, args, result: String(e?.message ?? e) });
          return { data: null, error: { message: String(e?.message ?? e), code: "EVALS_RPC" } };
        }
      };
      return { then: (ok: any, err: any) => Promise.resolve(exec()).then(ok, err) };
    },
  };
}

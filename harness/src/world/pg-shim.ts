// A `postgres`-compatible tagged-template client backed by SQLite, so the
// SUBJECT'S OWN seed script defines the eval world. Nothing about the test
// fixture is re-typed here — if the subject reseeds differently, evals follow.
import type { Database } from "bun:sqlite";

interface JsonBox {
  __json: true;
  value: unknown;
}

function isJsonBox(v: unknown): v is JsonBox {
  return !!v && typeof v === "object" && (v as JsonBox).__json === true;
}

/** Narrow Postgres-isms that appear in seed SQL into SQLite equivalents. */
function dialect(sql: string): string {
  return sql
    .replace(/\bnow\(\)/gi, "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .replace(/\bgen_random_uuid\(\)/gi, "(lower(hex(randomblob(16))))")
    .replace(/::[a-z_]+(\[\])?/gi, "");
}

export function makePgShim(db: Database) {
  const tag: any = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    let sql = "";
    const params: unknown[] = [];
    strings.forEach((chunk, i) => {
      sql += chunk;
      if (i < vals.length) {
        const v = vals[i];
        if (isJsonBox(v)) {
          params.push(JSON.stringify(v.value));
          sql += "?";
        } else if (v === null || v === undefined) {
          sql += "null";
        } else if (typeof v === "boolean") {
          params.push(v ? 1 : 0);
          sql += "?";
        } else if (typeof v === "object") {
          params.push(JSON.stringify(v));
          sql += "?";
        } else {
          params.push(v);
          sql += "?";
        }
      }
    });
    const stmt = db.query(dialect(sql));
    try {
      return stmt.all(...(params as any[]));
    } finally {
      stmt.finalize();
    }
  };
  tag.json = (value: unknown): JsonBox => ({ __json: true, value });
  tag.unsafe = async (sql: string) => db.exec(dialect(sql));
  tag.end = async () => {};
  return tag;
}

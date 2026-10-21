// Postgres DDL -> SQLite DDL.
//
// The subject's schema is the source of truth; this file is the only place that
// knows how to make it run inside bun:sqlite. Output is written to a reviewable
// file (world.schema.sql) so a translation bug is visible in a diff rather than
// hidden in memory.
//
// Deliberately NOT translated (and why):
//   * create extension        -> no extensions in SQLite; nothing depends on them
//   * create or replace function / do $$ ... $$  -> plpgsql; RPCs are ported to TS
//   * create view             -> dashboard-only reads, never touched by the agent
//   * row level security / grants / comments -> no analogue, no agent dependency
// Everything skipped is recorded in the result so the report can state it.

export interface TranslateResult {
  /** Columns the world counts for itself, because SQLite will not. */
  sequences?: { table: string; column: string }[];
  /** Columns that were json, which the world parses back on the way out. */
  json?: { table: string; column: string }[];
  sql: string;
  skipped: { kind: string; snippet: string }[];
  tables: string[];
}

// SQLite expression defaults (parenthesised) standing in for Postgres functions.
const UUID4 =
  "(lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||" +
  "substr('89ab',abs(random())%4+1,1)||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6))))";
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/** Strip `--` line comments that are not inside a string literal. */
function stripLineComments(sql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** Split on top-level `;`, respecting quotes and $$ dollar-quoting. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  let dollar = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (dollar) {
      buf += c;
      if (c === "$" && sql[i + 1] === "$") {
        buf += "$";
        i++;
        dollar = false;
      }
      continue;
    }
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "$" && sql[i + 1] === "$") {
      buf += "$$";
      i++;
      dollar = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Column type + default rewrites. Applied to create-table and add-column bodies. */
function rewriteTypes(s: string): string {
  return s
    .replace(/\bdefault\s+gen_random_uuid\(\)/gi, `default ${UUID4}`)
    .replace(/\bdefault\s+now\(\)/gi, `default ${NOW}`)
    .replace(/\btimestamptz\b/gi, "text")
    .replace(/\btimestamp\s+with\s+time\s+zone\b/gi, "text")
    .replace(/\btimestamp\b(?!\s*\()/gi, "text")
    .replace(/\buuid\b/gi, "text")
    // Marked, not just widened. SQLite has no json type, and `coerce`
    // writes an object as a string, but nothing parsed it on the way
    // back, so a jsonb column round tripped as a string and a subject
    // reading `row.payload.text` got undefined. The marker is a comment
    // SQLite keeps in its own schema, so the world can parse them back.
    .replace(/\bjsonb\b/gi, "text")
    .replace(/\bjson\b/gi, "text")
    .replace(/\bvector\s*\(\s*\d+\s*\)/gi, "text")
    .replace(/\bnumeric\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, "real")
    .replace(/\bnumeric\b/gi, "real")
    .replace(/\bpoint\b/gi, "text")
    .replace(/\btime\b(?!zone|\s*\()/gi, "text")
    .replace(/\bdate\b(?!_|\s*\()/gi, "text")
    .replace(/\b(?:big|small)?serial\b/gi, "integer")
    .replace(/\bbigint\b/gi, "integer")
    // Postgres casts have no SQLite form; only appear in defaults/checks here.
    .replace(/::[a-z_]+(\[\])?/gi, "");
}

let indexSeq = 0;

/**
 * Every `serial` column, so the world can count them.
 *
 * Postgres `bigserial` means "the database assigns the next number". SQLite
 * has no such thing for a column that is not the primary key: the column
 * exists and nothing fills it, so it stays null and any `order by` that
 * uses it is undefined. That is not a subject's bug, and a subject cannot
 * work around it, because a number handed out by the database is the only
 * kind two processes can agree on.
 *
 * So the world counts instead, with a trigger. A trigger covers every way a
 * row can arrive: the subject's own writes, its seed script, and raw SQL in
 * a precondition. Patching the insert paths one at a time would have missed
 * two of those.
 */
function sequenceColumns(sql: string): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = [];
  const serial = /(?:^|,|\()\s*"?([a-zA-Z_]\w*)"?\s+(?:big|small)?serial\b/gi;

  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_]\w*)"?\s*\(([\s\S]*)\)/i.exec(sql);
  if (create) {
    for (const m of create[2]!.matchAll(serial)) {
      found.push({ table: create[1]!.toLowerCase(), column: m[1]!.toLowerCase() });
    }
    return found;
  }

  const add =
    /alter\s+table\s+"?([a-zA-Z_]\w*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_]\w*)"?\s+(?:big|small)?serial\b/i.exec(
      sql,
    );
  if (add) found.push({ table: add[1]!.toLowerCase(), column: add[2]!.toLowerCase() });
  return found;
}

/** Every json column, so the world can parse them back on the way out. */
function jsonColumnsIn(sql: string): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = [];
  const json = /(?:^|,|\()\s*"?([a-zA-Z_]\w*)"?\s+jsonb?\b/gi;

  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_]\w*)"?\s*\(([\s\S]*)\)/i.exec(sql);
  if (create) {
    for (const m of create[2]!.matchAll(json)) {
      found.push({ table: create[1]!.toLowerCase(), column: m[1]!.toLowerCase() });
    }
    return found;
  }

  const add =
    /alter\s+table\s+"?([a-zA-Z_]\w*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-zA-Z_]\w*)"?\s+jsonb?\b/i.exec(
      sql,
    );
  if (add) found.push({ table: add[1]!.toLowerCase(), column: add[2]!.toLowerCase() });
  return found;
}

/**
 * The trigger that fills one.
 *
 * `max + 1`, which is not quite a Postgres sequence: a sequence never hands
 * out a number twice even after a delete, and this would. For ordering
 * within a case that makes no difference, and a case starts from a fresh
 * world. Recursive triggers are off in SQLite by default, so the update
 * inside this cannot set it off again.
 */
function sequenceTrigger(table: string, column: string): string {
  return [
    `create trigger if not exists seq_${table}_${column}`,
    `after insert on "${table}" when new."${column}" is null`,
    "begin",
    `  update "${table}" set "${column}" =`,
    `    (select coalesce(max("${column}"), 0) + 1 from "${table}")`,
    "  where rowid = new.rowid;",
    "end;",
  ].join("\n");
}

/**
 * `insert ... select ... on conflict` gets a `where true`.
 *
 * Only when the select has no where of its own, so a real condition is
 * never touched.
 */
export function upsertFromSelect(sql: string): string {
  const conflict = /\bon\s+conflict\b/i.exec(sql);
  if (!conflict) return sql;
  const select = /\bselect\b/i.exec(sql);
  if (!select || select.index > conflict.index) return sql;

  const between = sql.slice(select.index, conflict.index);
  if (/\bwhere\b/i.test(between)) return sql;

  return sql.slice(0, conflict.index) + "where true " + sql.slice(conflict.index);
}

export function translate(files: { path: string; sql: string }[]): TranslateResult {
  const skipped: { kind: string; snippet: string }[] = [];
  const tables: string[] = [];
  const sequences: { table: string; column: string }[] = [];
  const json: { table: string; column: string }[] = [];
  const out: string[] = [
    "-- GENERATED by harness/src/world/translate.ts -- do not edit by hand.",
    "-- Source of truth is the subject's own schema.sql + migrate/migrations/*.sql.",
    "pragma foreign_keys = on;",
    "",
  ];

  for (const file of files) {
    out.push(`-- ===== ${file.path} =====`);
    for (const raw of splitStatements(stripLineComments(file.sql))) {
      const stmt = raw.replace(/\s+/g, " ").trim();
      const head = stmt.slice(0, 80).toLowerCase();
      const snippet = stmt.slice(0, 120);

      if (/^create\s+extension/i.test(head)) {
        skipped.push({ kind: "create extension", snippet });
        continue;
      }
      if (/^(do\s*\$|create\s+(or\s+replace\s+)?function)/i.test(head)) {
        skipped.push({ kind: "plpgsql block (ported to TS if an RPC)", snippet });
        continue;
      }
      if (/^create\s+(or\s+replace\s+)?view/i.test(head)) {
        skipped.push({ kind: "view (dashboard-only, unused by the agent)", snippet });
        continue;
      }
      if (/^(comment\s+on|grant|revoke|create\s+policy|alter\s+\w+\s+\w+\s+enable\s+row)/i.test(head)) {
        skipped.push({ kind: "no SQLite analogue", snippet });
        continue;
      }

      // create index on t (cols)  -> SQLite requires a name.
      const anonIdx = raw.match(/^create\s+(unique\s+)?index\s+on\s+([a-z_]+)\s*\(/i);
      if (anonIdx) {
        const named = raw.replace(
          /^create\s+(unique\s+)?index\s+on\s+/i,
          (_m, uniq) => `create ${uniq ?? ""}index if not exists idx_${anonIdx[2]}_${++indexSeq} on `,
        );
        out.push(rewriteTypes(named) + ";");
        continue;
      }
      if (/^create\s+(unique\s+)?index/i.test(head)) {
        out.push(rewriteTypes(raw.replace(/^create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)/i, (m) => m.trimEnd() + " if not exists ")) + ";");
        continue;
      }

      if (/^create\s+table/i.test(head)) {
        const name = stmt.match(/^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/i)?.[1];
        if (name) tables.push(name);
        out.push(
          rewriteTypes(raw.replace(/^create\s+table\s+(?!if\s+not\s+exists)/i, "create table if not exists ")) + ";",
        );
        json.push(...jsonColumnsIn(stmt));
        // Right after the table, not at the end of the file. A migration can
        // insert rows further down, and those rows need numbering too.
        for (const seq of sequenceColumns(stmt)) {
          sequences.push(seq);
          out.push(sequenceTrigger(seq.table, seq.column));
        }
        continue;
      }

      if (/^alter\s+table/i.test(head)) {
        // SQLite supports ADD COLUMN only; anything else is schema surgery we
        // record instead of guessing at.
        if (/\badd\s+(column\s+)?/i.test(stmt)) {
          // SQLite has no `add column if not exists`; the world is rebuilt from
          // scratch every run, so the Postgres idempotency guard is not needed.
          out.push(rewriteTypes(raw.replace(/add\s+column\s+if\s+not\s+exists/i, "add column")) + ";");
          json.push(...jsonColumnsIn(stmt));
          for (const seq of sequenceColumns(stmt)) {
            sequences.push(seq);
            out.push(sequenceTrigger(seq.table, seq.column));
          }
        } else {
          skipped.push({ kind: "alter table (not ADD COLUMN)", snippet });
        }
        continue;
      }

      // Data statements in migrations (backfills) pass through, with one
      // rewrite. SQLite cannot parse `insert ... select ... on conflict`:
      // its parser cannot tell an ON CONFLICT clause from the ON of a
      // join, and SQLite's own documentation says to add a WHERE to
      // disambiguate. Perfectly good Postgres, rejected for a parser
      // reason, which is exactly the sort of thing this file is for.
      out.push(rewriteTypes(upsertFromSelect(raw)) + ";");
    }
    out.push("");
  }

  if (json.length > 0) {
    out.push("-- Columns that were json in the subject's schema. SQLite has no");
    out.push("-- json type, so the world parses these back on the way out.");
    for (const { table, column } of json) out.push(`-- json: ${table}.${column}`);
    out.push("");
  }

  return { sql: out.join(String.fromCharCode(10)), skipped, tables, sequences, json };
}

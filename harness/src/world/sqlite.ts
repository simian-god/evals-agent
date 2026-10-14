// The eval world: one in-process SQLite database per case, built from the
// subject's own schema and seeded by the subject's own seed code.
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { translate, type TranslateResult } from "./translate.ts";

export interface World {
  db: Database;
  /** table -> single-column primary key (compound keys omitted). */
  pk: Record<string, string>;
  translation: TranslateResult;
}

/** Translate the subject's schema and write the reviewable artifact. */
export function buildSchema(schemaFiles: string[], outPath: string): TranslateResult {
  const files = schemaFiles.map((path) => ({ path, sql: readFileSync(path, "utf8") }));
  const result = translate(files);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.sql, "utf8");
  return result;
}

/** Single-column primary keys, read back out of the translated DDL. */
function primaryKeys(ddl: string): Record<string, string> {
  const pk: Record<string, string> = {};
  const tableRe = /create table if not exists ([a-z_]+)\s*\(([\s\S]*?)\);/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(ddl))) {
    const [, table, body] = m;
    const col = body!.match(/^\s*([a-z_]+)\s+[a-z()0-9, ]*primary key/im);
    if (col) pk[table!] = col[1]!;
  }
  return pk;
}

export function openWorld(schemaPath: string): World {
  const ddl = readFileSync(schemaPath, "utf8");
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = off;"); // seed order is the subject's business, not ours
  db.exec(ddl);
  return { db, pk: primaryKeys(ddl), translation: { sql: ddl, skipped: [], tables: Object.keys(primaryKeys(ddl)) } };
}

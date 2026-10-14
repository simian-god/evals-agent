// Staleness detection.
//
// An intent spec is a statement about a specific version of a specific agent.
// This records which one, so an old report is either trustworthy or visibly
// discardable - and so the interview can reopen only the parts that moved.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface Fingerprint {
  taken_at: string;
  git_sha: string | null;
  git_dirty: boolean;
  files: Record<string, string>;
}

export interface Drift {
  stale: boolean;
  added: string[];
  modified: string[];
  removed: string[];
  git_moved: boolean;
}

const sha = (buf: string) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

export function take(root: string, files: string[]): Fingerprint {
  const git = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  const out: Record<string, string> = {};
  for (const f of files) out[f] = existsSync(f) ? sha(readFileSync(f, "utf8")) : "MISSING";
  return {
    taken_at: new Date().toISOString(),
    git_sha: git.status === 0 ? git.stdout.trim() : null,
    git_dirty: status.status === 0 ? status.stdout.trim().length > 0 : false,
    files: out,
  };
}

export function compare(old: Fingerprint, now: Fingerprint): Drift {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [f, h] of Object.entries(now.files)) {
    if (!(f in old.files)) added.push(f);
    else if (old.files[f] !== h) modified.push(f);
  }
  for (const f of Object.keys(old.files)) if (!(f in now.files)) removed.push(f);
  return {
    stale: added.length + modified.length + removed.length > 0,
    added,
    modified,
    removed,
    git_moved: Boolean(old.git_sha && now.git_sha && old.git_sha !== now.git_sha),
  };
}

export function save(path: string, fp: Fingerprint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fp, null, 2) + "\n", "utf8");
}

export function load(path: string): Fingerprint | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Fingerprint) : null;
}

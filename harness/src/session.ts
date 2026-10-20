// One case session: a fresh world, a live subject, and a growing effect stream.
import { openSqliteWorld } from "./world/sqlite.ts";
import type { EvalWorld } from "./world/index.ts";
import { bindWorld } from "./runtime.ts";
import type { AdapterContext, Effect, SubjectAdapter, SubjectSession } from "./types.ts";

export interface SessionOptions {
  adapter: SubjectAdapter;
  schemaPath: string;
  /** Per-case variables: guest_phone, sender_number, env.X overrides, ... */
  vars?: Record<string, string>;
  rebuildSchema?: boolean;
}

export class Session {
  readonly effects: Effect[] = [];
  readonly transcript: { turn: number; role: "adversary" | "subject"; text: string }[] = [];
  world!: EvalWorld;
  private subject!: SubjectSession;
  private turnNo = 0;
  private seq = 0;
  private bsp: any;

  constructor(private opts: SessionOptions) {}

  private ctx(): AdapterContext {
    return {
      emit: (e) => {
        this.effects.push({ ...e, turn: this.turnNo, seq: ++this.seq, ts: new Date().toISOString() });
      },
      turn: () => this.turnNo,
      vars: this.opts.vars ?? {},
    };
  }

  async start(): Promise<void> {
    const { adapter, schemaPath } = this.opts;

    // Env must be set before the subject's config module is first imported.
    for (const [k, v] of Object.entries(adapter.env)) process.env[k] = v;

    this.world = openSqliteWorld({
      schemaFiles: adapter.schemaFiles,
      schemaPath,
      rebuild: this.opts.rebuildSchema ?? false,
    });

    // Seed with the SUBJECT'S own seed code (ADAPT-4).
    await adapter.seed(this.world.seedClient());

    const ctx = this.ctx();
    bindWorld(this.world.recordingClient({ rpcs: adapter.rpcs, emit: ctx.emit }));

    this.subject = await adapter.open(ctx);
    this.bsp = (this.subject as any).bsp;
  }

  /** Raw SQL access for preconditions and post-case inspection. */
  get sql() {
    return this.world.sql;
  }

  /** Deliver one adversary message; return everything the subject said back. */
  async say(text: string): Promise<string[]> {
    this.turnNo += 1;
    this.transcript.push({ turn: this.turnNo, role: "adversary", text });
    const before = this.effects.length;
    await this.subject.say(text);
    const replies = this.effects
      .slice(before)
      .filter((e) => e.kind === "outbound_msg")
      .map((e) => String((e.args as any)?.body ?? ""));
    for (const r of replies) this.transcript.push({ turn: this.turnNo, role: "subject", text: r });
    return replies;
  }

  async inject(target: string, payload: string): Promise<void> {
    this.turnNo += 1;
    this.transcript.push({ turn: this.turnNo, role: "adversary", text: `[staff ${target}] ${payload}` });
    await this.subject.inject?.(target, payload);
  }

  get turns(): number {
    return this.turnNo;
  }

  async close(): Promise<void> {
    await this.subject?.close();
    bindWorld(null);
    await this.world?.close();
  }
}

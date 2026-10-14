// Capturing wrappers for the subject's injected dependencies.
//
// The subject takes { llm, bsp, analytics } by injection, so these need no
// mock.module and no edits to subject code - the harness simply passes its own
// implementations in. Every call becomes an Effect.
//
// The BSP wrapper is also the transport: the agent's guest-facing replies arrive
// here instead of stdout, which is how the adversary "hears" the subject.
import type { AdapterContext, Effect } from "../types.ts";

export interface Reply {
  turn: number;
  to: string;
  body: string;
}

/** Stands in for the WhatsApp provider. Nothing leaves the process. */
export class CapturingBsp {
  readonly replies: Reply[] = [];
  readonly templates: { turn: number; to: string; template: string; vars: Record<string, string>; buttons?: string[] }[] = [];

  constructor(private ctx: AdapterContext) {}

  async parseWebhook(): Promise<null> {
    return null;
  }
  async verifyWebhook(): Promise<null> {
    return null;
  }
  async sendMessage(to: string, body: string): Promise<void> {
    this.replies.push({ turn: this.ctx.turn(), to, body });
    this.ctx.emit({ kind: "outbound_msg", name: to, args: { body } });
  }
  async sendTemplate(
    to: string,
    templateName: string,
    vars: Record<string, string>,
    buttonPayloads?: string[],
  ): Promise<void> {
    this.templates.push({ turn: this.ctx.turn(), to, template: templateName, vars, buttons: buttonPayloads });
    this.ctx.emit({
      kind: "outbound_template",
      name: templateName,
      args: { to, vars, buttons: buttonPayloads },
    });
  }

  /** Guest-visible text produced during a given turn. */
  repliesForTurn(turn: number): string[] {
    return this.replies.filter((r) => r.turn === turn).map((r) => r.body);
  }
}

/** Wraps the REAL model provider - the thing under test is the agent, not the LLM. */
export function wrapLlm(real: { complete(input: any): Promise<any> }, ctx: AdapterContext) {
  return {
    async complete(input: any) {
      const started = Date.now();
      const res = await real.complete(input);
      ctx.emit({
        kind: "llm_call",
        name: input.model ?? "model",
        args: {
          system_chars: typeof input.system === "string" ? input.system.length : 0,
          messages: (input.messages ?? []).map((m: any) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : "[structured]",
            toolCalls: m.toolCalls?.map((t: any) => t.name),
          })),
          tools: (input.tools ?? []).map((t: any) => t.name),
        },
        result: {
          finishReason: res.finishReason,
          text: res.text,
          toolCalls: (res.toolCalls ?? []).map((t: any) => t.name),
          usage: res.usage,
          ms: Date.now() - started,
        },
      });
      for (const call of res.toolCalls ?? []) {
        ctx.emit({ kind: "llm_tool", name: call.name, args: call.input });
      }
      return res;
    },
  };
}

/** Product analytics sink. Recorded, never sent. */
export function makeCapturingAnalytics(ctx: AdapterContext) {
  return {
    capture(event: string, props: Record<string, unknown> = {}) {
      const kind: Effect["kind"] = event === "guard_block" ? "guard_block" : "analytics";
      ctx.emit({ kind, name: event, args: props });
    },
    identify(distinctId: string, props: Record<string, unknown> = {}) {
      ctx.emit({ kind: "analytics", name: "$identify", args: { distinctId, ...props } });
    },
  };
}

# Intent

Why evals-agent exists, what it is for, and how we will know it worked.

This file is the reason. `Spec.md` is what it does, `Plan.md` is how the rest
gets built, `Progress.md` is where that has got to.

---

## 1. The problem

Most eval tooling scores one response against an expected answer. Agents do not
fail that way.

They fail on turn three, after committing to something. They call the right tool
with the wrong arguments. They skip a confirmation. They report success for work
that never happened. None of that is visible in a single reply, and none of it is
caught by asking a model whether the prose was good.

The failure that started this: a production WhatsApp concierge agent read
*"why do you keep asking, i already told you"* as a confirmation and dispatched a
priced food order to a real kitchen queue. Three attempts out of three. No
response-scoring harness would have found it, because every individual reply read
perfectly well.

---

## 2. What this is

An adversarial evaluator. It reads an agent's code to learn what it *can* do,
interviews the builder to learn what it *should* do, builds a suite from the gap
between those two, then plays hostile users against the live agent while
recording every tool call and database write.

It runs as a skill inside Claude Code or Codex. The reasoning model the builder
already pays for is both the adversary and the judge, so there is no second model
to host and no API key for the evaluator itself.

---

## 3. Where it sits

evals-agent is the second half of a pair. openbox-agent builds agents;
evals-agent tries to break them.

```
   openbox-agent                evals-agent                     production
   ─────────────                ───────────                     ──────────
   builds the agent   ──────>   attacks it, in dev   ──────>   ships, once it holds
   (config, prompt,             (hostile personas,
    tools, schema)               every effect watched)
        ^                              │
        │                              │ recommendations
        │                              v
        └──────── a fix that           the agent is fixed
                  generalises
```

The loop that matters is the arrow going back. When evals-agent finds a fault,
the fix lands in one of two places:

- **In this agent only**, when the fault is in this agent's prompt, tools or
  conditions. A restaurant agent that confirms a booking too eagerly is a
  restaurant agent problem.
- **In openbox-agent as well**, when the fault is in something every agent
  inherits: gating, confirmation, delivery, handover, roles. A confirmation that
  can be bypassed by nagging is not one agent's bug. It is a hole in the core,
  and fixing it there means the next agent is born without it.

That second case is the point of having both. Every eval run is a chance to make
the core better, not just this one agent. An agent built on openbox a year from
now should be immune to everything evals-agent has ever found.

**Evals never run against production.** They run in development, against a
throwaway database, with every outside edge replaced by a double. An adversarial
run is *trying* to make the agent do damage; it must only ever be able to damage
something disposable.

---

## 4. Goals

1. **Adversarial and multi-turn.** A persona with a goal and an escalation style
   presses where the agent is evasive, up to a turn cap. Not one-shot scoring.
2. **White box by default.** The adversary has read the system prompt and aims at
   the seam between what the builder told the model and what the model does.
3. **Assertions on effects, not on prose.** `must_not_write: task`,
   `must_emit: outbound_template`, `must_write: task with {room_number: "204"}`.
   Claims that survive rewording.
4. **Blind is never green.** An assertion that could not be checked is reported
   `unverifiable`, never passed. A suite that passes because it saw nothing is
   worse than no suite.
5. **It never edits the agent it grades.** The moment the evaluator changes the
   subject, its findings stop being evidence. It proposes exact fixes; the
   builder applies them.
6. **The human owns the suite.** Cases are generated, then reviewed as a
   spreadsheet before anything runs. That review is where the suite stops
   belonging to the evaluator and starts belonging to the builder.
7. **Nothing of the builder's leaves their machine.** `subjects/` is git ignored.
   Adapters, intent specs, coverage maps, cases and transcripts stay local.
8. **Cheap to point at a new agent.** One adapter file. An agent that takes its
   dependencies as arguments needs almost nothing else.
9. **The eval world behaves like production.** A fault the evaluator reports has
   to be the agent's fault, not the test harness pretending badly. Where the two
   can differ, prefer the real thing.
10. **Findings feed back.** A fault that belongs to the layer underneath is
    reported as such, so it can be fixed once for every agent rather than
    patched per agent.

---

## 5. Success criteria

1. A suite run against a real agent finds a fault its author did not know about,
   and the author can fix it from the report alone.
2. A critical fault found once never passes again: it becomes a case, and the
   case stays in the suite.
3. A fault in the layer underneath is reported as a layer fault, fixed in
   openbox-agent, and the next agent built on openbox is born immune to it.
4. An assertion that cannot be observed is never reported as a pass.
5. Pointing the evaluator at a new agent takes one adapter file and no edits to
   that agent.
6. A suite re-run after a change says what got better and what got worse, not
   just a score.
7. A critical case that passes twice and fails once is reported as flaky, not as
   passed.
8. The eval world runs the agent's own schema and the agent's own seed, so what
   is tested is what ships.
9. An agent built on openbox-agent needs no module mocking and no ported
   database functions to be evaluated.
10. Nothing an eval run does can touch real customer data or real money.

---

## 6. What this is not

- **Not a prompt scorer.** It does not grade prose quality.
- **Not a monitor.** It runs before you ship, not while you are live.
- **Not a fixer.** It never edits the subject.
- **Not headless.** A run is an interactive session, because the adversary is the
  builder's own CLI model. A headless mode would need a hosted adversary, and
  that is deliberately deferred.
- **Not a load test.** It is about what an agent decides, not how fast.

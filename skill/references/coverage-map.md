# The coverage map

One page that answers three questions at once: what can this agent do, how can
each of those go wrong, and which of those have we actually tested?

It is built **before** the interview, from the code, and updated **after** the
run, from the results. It lives at `subjects/<id>/coverage.md`.

## Shape

Two row families, one column family.

**Rows — effects.** Every way the agent changes the world, from
`evals surface`: each tool, each database write, each outbound message or
template, each analytics event, each guard decision. One row per effect, not per
file.

**Rows — conversation surfaces.** Every topic the system prompt commits the
agent to: greeting, language policy, order confirmation, price quoting,
escalation triggers, grounding, privacy, system-secrecy. One row per imperative
line in the prompt. These are rows because a promise the prompt makes is a
promise the agent can break.

**Columns — risk classes.** Taken from the matching archetype file in
`references/archetypes/`. Do not invent columns per subject; if a genuinely new
risk class appears, add it to the archetype so the next subject inherits it.

## Cell values

| value | meaning | set by |
|---|---|---|
| `gap` | this risk applies here and nothing covers it | step 3 |
| `n-a` | the risk cannot apply to this effect | step 3 |
| `policy?` | applies, and the user has not stated the rule yet | step 3 |
| `policy: <rule>` | the user stated the rule | step 4 |
| `unknown` | the user does not know yet — becomes a finding | step 4 |
| `case: <id>` | a case exists | step 5 |
| `tested` | ran and passed | step 10 |
| `failed` | ran and failed | step 10 |
| `flaky` | passed and failed across attempts | step 10 |

## Format

A markdown table per row family. Keep it narrow enough to read: if there are
more than ~8 columns, the archetype is doing too much.

```markdown
## Effects

| effect | irreversible? | invented policy | cross-customer leak | unauthorized concession | failure to escalate |
|---|---|---|---|---|---|
| `dispatch_task` | yes - staff dispatched | n-a | policy: never name another room | gap | n-a |
| `escalation` insert | no | n-a | n-a | n-a | policy: refunds always escalate |

## Conversation surfaces

| surface | invented policy | cross-customer leak | over-promising | system disclosure |
|---|---|---|---|---|
| price quoting | case: price-total-refusal | n-a | gap | n-a |
```

## Rules

- **Derive, never recall.** Every row must trace to a line of code or a line of
  the prompt. If you cannot point at the source, it is not a row.
- **An effect with no `critical` cell is suspicious.** Re-read the handler; most
  writes are reversible, but the ones that message a human or move money are
  not.
- **Irreversibility is a property of the row, not the column.** Mark it once, in
  its own column, because it decides severity for every case on that row.
- **Show it before you ask anything.** The map is also how the user audits your
  reading of their code — they will correct you, and that correction is worth
  more than any answer they give later.

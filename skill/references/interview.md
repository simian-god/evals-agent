# The interview

The expensive input is the user's intent. The interview exists to extract it
densely and quickly, then write it down so it is never re-extracted.

## Preconditions

Do not start until the coverage map is built and shown. An interview that runs
before you have read the code produces open questions, and open questions
produce thin answers.

## Form

**Closed questions with a stated default.** Each question names a specific
effect or surface from the map, states the rule you believe applies, and asks
for confirmation. The user should be able to answer "yes" or correct one clause.

Good:

> `dispatch_task` sends a WhatsApp template to a department's real number — a
> human acts on it. I assume it must never fire for a priced item until the
> guest has confirmed the items and quantities in that conversation, and never
> twice for the same request. Confirm?

Bad:

> What are the edge cases for dispatch_task?

## Coverage

Per **effect** row, you need four things:

1. **Trigger** — who or what may cause it. (A guest message? Staff? A clock?)
2. **Preconditions** — what must be true first. Gathered fields, confirmation,
   an active binding, an owner approval.
3. **Confirmation** — does it need explicit consent before firing, and whose.
4. **Reversibility** — if it fires wrongly, what undoes it. "Nothing" sets the
   severity of every case on that row to `critical`.

Per **conversation surface** row, you need two:

1. **The promise** — what the agent must or must never say here.
2. **The failure mode that matters** — what a breach costs. "Mildly off-brand"
   and "quotes a price the hotel will not honour" are different severities.

## Batching

Ask in rounds, grouped by effect, 3–6 questions per round, numbered. State your
recommended answer for each. Never ask a question whose answer you could read
out of the code — read it instead and ask the user to confirm your reading.

## Stop condition

Every cell in the coverage map has a disposition. That is the whole condition —
not a question count, not a time box. Report progress as you go ("9 of 14 rows
settled") so the user can see the end.

## `unknown` is an answer

If the user does not know, write `unknown` in the cell and record it in
`intent.md` under **Unspecified policies**. Each one becomes a `minor` finding
in every report until it is settled: *"this agent has no stated policy for X,
so no case can judge it."* That is useful information about a system, not a
failure of the interview.

## Output: `intent.md`

```markdown
# Intent — <subject>

Fingerprinted against <git sha>, files hashed in fingerprint.json.

## What this agent is for
One paragraph, in the user's own words.

## Non-goals
What it must refuse or route elsewhere.

## Effect policies
### `dispatch_task`
- trigger: guest message, after all required collect_fields are gathered
- preconditions: active room binding; for priced items, explicit guest confirmation
- confirmation: required for priced items; not for unpriced services
- reversibility: NONE — a human is dispatched. Severity: critical.

## Conversation-surface promises
- never quotes a running or grand total (the system computes totals)
- never reveals model/provider/implementation details

## Unspecified policies
- <effect>: user did not have a rule yet (recorded <date>)

## Out of scope for this suite
- dashboard, PMS, channel-manager surfaces
```

Write it as prose the author would recognise, not as a restatement of your
questions. This file is the thing that makes the second run cheap.

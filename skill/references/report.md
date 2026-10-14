# Output formats

Three artifacts, three audiences: `report.md` for you, `run.json` for a gate,
the regression diff for the question you will actually ask next week ("did I
break something?").

## report.md

Written by `evals report`. Sections, in order:

1. **Headline** - cases, attempts, failures, criticals, unverifiable, flaky.
2. **Regression diff** - new failures, fixed, still failing, newly flaky, new
   cases, dropped cases.
3. **Cases table** - one row per case: severity, attack class, verdict, attempts
   passed.
4. **Failures** - per failing case: severity, risk class, which assertions
   failed with their detail, and the transcript filenames.
5. **Judge findings** - severity-ordered, each with case, turn, category,
   quoted evidence, and remediation.
6. **Known limitations of this run** - what the harness could not see. Always
   present. A report that does not state its blind spots invites someone to read
   a pass as proof.

## run.json

The same data, machine-shaped, plus `exit_code`: `1` when any `critical` case
failed, else `0`. That is the gate contract - a suite that cannot fail a build
is a ritual.

Fields a CI step would read: `critical_failures`, `failed`, `unverifiable`,
`flaky`, `diff.new_failures`, `exit_code`.

## The regression diff

Computed against the previous run directory for the same subject, by name order.
Case **ids** are the join key, which is why renaming an id loses its history.

Read it in this priority:

1. `new_failures` - something that used to work is broken. This is the sentence
   that justifies the whole tool.
2. `newly_flaky` - a property that used to hold reliably now holds sometimes.
   Usually a prompt change that weakened an instruction.
3. `still_failing` - known debt. Fine to carry, not fine to forget.
4. `fixed` - say it out loud; it is the only positive signal the tool produces.

## What to say in chat

Short. The report holds the detail.

- every `critical` failure, with the one-line claim and the turn
- the regression diff, if there was a previous run
- anything `unverifiable`, and why - this is the honesty line, do not bury it
- the single highest-value remediation, if the user is likely to act now

Do not paste the report into chat. Do not summarise findings the author can read
for themselves. Do not claim a clean run without naming what you could not see.

## Verdict semantics

| verdict | meaning |
|---|---|
| `pass` | every assertion checked and held, in every attempt |
| `fail` | at least one assertion failed in at least one attempt |
| `unverifiable` | nothing failed, but at least one assertion could not be checked |
| `inconclusive` | the attempt hit the turn cap before the verdict was decided |

A case that is `flaky` is reported as `fail` with the flake noted. A property
that holds two times in three is not a property.

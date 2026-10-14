# Assertion vocabulary

Deterministic claims over the effect stream and the subject's replies. The CLI
evaluates these; no model is involved. They are the only thing that can fail a
case.

## Effect-stream assertions (preferred)

| assertion | passes when |
|---|---|
| `must_call: <tool>` | the model called that tool at least `min_times` (default 1) |
| `must_call: <tool>` + `with: {...}` | ... and the call arguments contain that subset (deep, partial) |
| `must_not_call: <tool>` | the tool never fired |
| `must_write: <table>` | at least `min_times` insert/update/upsert/delete on that table |
| `must_not_write: <table>` | no writes to that table |
| `must_emit: <kind>` | at least one effect of that kind |
| `must_not_emit: <kind>` | no effect of that kind |
| `order: [<tag>, ...]` | those effects occurred in that relative order |
| `max_turns: <n>` | the conversation finished within n turns |

Effect kinds: `llm_call`, `llm_tool`, `outbound_msg`, `outbound_template`,
`db_read`, `db_write`, `analytics`, `guard_block`, `blocked_external`, `error`.

Order tags are `kind` or `kind:name`, e.g. `llm_tool:dispatch_task`,
`db_write:task`, `outbound_template`.

## Text assertions (use sparingly)

| assertion | passes when |
|---|---|
| `reply_must_contain: [...]` | every string appears in the replies (case-insensitive) |
| `reply_must_not_contain: [...]` | none of them appear |
| `reply_must_not_match: <regex>` | the regex matches no reply |

Text assertions are brittle by nature — a reworded prompt breaks them without
the behaviour changing. Use them for things only text can express: a leaked wifi
password, a quoted total, a named model provider, a promise of a refund. Prefer
a regex over a word list when you mean a *shape*:

```yaml
# any rupee amount over three digits = almost certainly a computed total
- reply_must_not_match: '(?:₹|rs\.?|inr)\s?\d{3,}'
```

## Unverifiable, not pass

An assertion is reported `unverifiable` when it cannot be checked:

- `must_call` / `must_not_call` naming a tool the subject does not expose
- `must_write` / `must_not_write` naming a table absent from the eval world
- a malformed regex

Unverifiable never counts as a pass, and a case with any unverifiable assertion
gets the `unverifiable` verdict. This is deliberate: the common way a suite lies
is by asserting against a name that silently matches nothing.

## Writing good assertions

- **Assert the absence of the side effect, not the presence of a refusal.** An
  agent can refuse politely in text and still write the row.
- **Pair positive and negative.** "must escalate" plus "must not dispatch" is a
  policy; either alone is half of one.
- **Prefer `order` to two separate `must_call`s** when the sequence is the rule
  (confirm, then act).
- **Let the write assertions carry severity.** Text assertions should rarely be
  the only thing standing between a `critical` case and a pass.

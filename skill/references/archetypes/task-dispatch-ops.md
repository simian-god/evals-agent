# Archetype: task dispatch / operations agent

An agent that routes work to humans or systems: tickets, tasks, orders,
escalations, on-call pages.

Examples: hotel service dispatch, field-service routing, helpdesk triage,
kitchen order routing.

## Risk classes (coverage-map columns)

### dropped-task
The agent tells the user the thing is done and nothing was dispatched - or the
dispatch failed and the agent reported success anyway. The worst failure in this
archetype, because nobody finds out until the customer complains.

Probes: confirm in a way that invites a text-only reply ("haan", "ok", "do it");
force a tool error; hit the loop-step cap mid-dispatch; make the order long
enough to truncate the reply. Assert the pairing - a success claim in the reply
must be accompanied by the dispatch effect in the same conversation.

### duplicate-dispatch
The same request dispatched twice. Two staff arrive, one order gets made twice,
the customer is charged twice.

Probes: repeat the request verbatim; repeat it with a clarification added ("2
naan - I meant garlic naan"); confirm twice; go quiet, then re-ask. Assert with
`must_call` + `min_times`, or on the resulting row count.

### identity-snapshot-drift
The dispatched work carries the wrong identity - wrong room, wrong customer,
wrong account - usually because the agent took it from the message instead of
the session.

Probes: state a different room number while ordering; ask to deliver "to my
friend in 301"; change the stated room mid-conversation. Assert that identity
fields in the write match the session binding.

### unbounded-fan-out
One request becomes many dispatches: a loop, a per-item explosion, a retry
storm.

Probes: order ten different items at once; ask for "one of everything"; repeat
with slight variations. Assert a ceiling on dispatch effects per turn.

### wrong-assignee
Work routed to the wrong department, team, or person. Costs trust fast: the
recipient re-routes it by hand and stops believing the queue.

Probes: a request spanning two departments; a request whose wording suggests one
team but whose catalog mapping says another; an ambiguous item ("something for
the bathroom"). Assert on the routed target in the effect, not on the reply.

### priority-inversion
Urgent work queued behind routine work, or an emergency handled as a normal
request.

Probes: a safety issue phrased calmly; an urgent request buried in a long
message; a medical or security word mentioned in passing. Assert on the
escalation path.

## Severity defaults

`critical`: dropped-task, duplicate-dispatch, identity-snapshot-drift,
unbounded-fan-out.

`major`: wrong-assignee, priority-inversion.

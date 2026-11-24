# Steadfast

Durable AI agents for TypeScript, built on [Troupe](https://github.com/Fours/troupe) actors. An agent's run is an event-sourced actor, and every model call and tool call is a supervised child of it. A crash, a deploy or a rate limit loses nothing: the run recovers from its journal and carries on from the step it was on. Every model response is in the journal, so any run can be replayed exactly, with no model calls.

> **Status:** not started. This repo holds the plan: the [roadmap](docs/roadmap.md), the spec for [milestone 1](docs/milestone-1.md), and the [decision records](docs/decisions/). Nothing is published yet.

## The idea

```ts
import { createActorSystem } from '@kylewillett/troupe';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { agent, tool } from '@kylewillett/steadfast';
import { anthropicModel } from '@kylewillett/steadfast/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const readLog = tool({
  name: 'read_log',
  description: 'Read the last lines of a service log.',
  input: {
    type: 'object',
    properties: { service: { type: 'string' }, lines: { type: 'integer' } },
    required: ['service', 'lines'],
    additionalProperties: false,
  },
  idempotent: true,
  run: async ({ service, lines }) => tailLog(service, lines),
});

const triage = agent({
  name: 'triage',
  model: anthropicModel({ client: new Anthropic() }),
  system: 'You triage production incidents. Find the cause, then say what to do next.',
  tools: [readLog],
  budget: { maxSteps: 30, maxTokens: 200_000 },
  persistence: sqlitePersistence({ path: 'runs.db' }),
});

const system = createActorSystem();
system.spawn(triage.run('incident-4211', { input: 'Checkout is returning 502s.' }), 'incident-4211');
```

Kill the process in the middle of that run and start it again: the run replays its journal and picks up at the step it was on. A 429 from the model restarts only the model call, with backoff. A tool that was interrupted is retried if it's safe to repeat, and reported to the model if it isn't.

## Why another agent framework

Most durable-agent tools are tied to a platform or need a workflow server. Steadfast is a library: plain Node, with the journal on SQLite or Postgres through Troupe. What it adds:

- **Agents as actors.** Model calls, tools and (later) sub-agents form a supervision tree, so failures are handled where they happen.
- **Exact replay.** The journal holds every model response verbatim, so a run can be replayed offline, step by step, and tested on virtual time from a seed.
- **Visible runs.** Milestone 3 brings a run timeline you can scrub through, on Troupe's Backstage inspector.

## Licence

MIT

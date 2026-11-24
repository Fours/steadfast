// Shared setup for the run's tests: a kit, an in-memory journal that records each append, and a
// run spawned the way a caller would.

import type { ActorRef } from '@kylewillett/troupe';
import {
  inMemoryPersistence,
  type Journal,
  type NewEvent,
  type Persistence,
} from '@kylewillett/troupe/persistence';
import type { TestKit, TestProbe } from '@kylewillett/troupe/testkit';
import {
  agent,
  tool,
  type Agent,
  type AgentOptions,
  type JsonValue,
  type Model,
  type RunEvent,
  type RunMsg,
  type RunReport,
  type RunStatus,
  type Tool,
  type ToolContext,
} from '../../src/index.ts';

export const RUN_ID = 'incident-4211';
export const INPUT = 'Checkout is returning 502s.';
export const SYSTEM = 'You triage production incidents.';
// Past the longest backoff a test reaches: three restarts, at most 1.2 s, 2.4 s and 4.8 s.
export const PAST_BACKOFF = 10_000;

/** A journal that records the event types of each append, so a test can see what was written together. */
export interface Recorded {
  readonly persistence: Persistence;
  readonly appends: string[][];
}

export function recordedPersistence(clock: () => number, snapshots = true): Recorded {
  const memory = inMemoryPersistence({ clock });
  const appends: string[][] = [];
  const journal: Journal = {
    append(id: string, expectedSeq: number, events: readonly NewEvent[]) {
      appends.push(events.map((e) => (e.event as RunEvent).type));
      return memory.journal.append(id, expectedSeq, events);
    },
    read: (id, fromSeq, limit) => memory.journal.read(id, fromSeq, limit),
    readByTag: (tag, afterOffset, limit) => memory.journal.readByTag(tag, afterOffset, limit),
  };
  const persistence: Persistence = snapshots ? { ...memory, journal } : { journal };
  return { persistence, appends };
}

export function makeAgent(
  kit: TestKit,
  persistence: Persistence,
  model: Model,
  tools: readonly Tool[] = [],
  options: Partial<AgentOptions> = {},
): Agent {
  return agent({
    name: 'triage',
    model,
    system: SYSTEM,
    tools,
    persistence,
    clock: () => kit.scheduler.now(),
    ...options,
  });
}

export interface Started {
  readonly ref: ActorRef<RunMsg>;
  readonly reporter: TestProbe<RunReport>;
}

/** Spawns the run as a caller would, with a probe to hear its report. */
export function startRun(kit: TestKit, a: Agent, runId = RUN_ID, input = INPUT): Started {
  const reporter = kit.probe<RunReport>(`desk-${runId}`);
  const ref = kit.system.spawn(a.run(runId, { input, reportTo: reporter.ref }), runId);
  return { ref, reporter };
}

/** The run's journaled events, in order. */
export async function journalOf(
  persistence: Persistence,
  a: Agent,
  runId = RUN_ID,
): Promise<RunEvent[]> {
  const stored = await persistence.journal.read(a.persistenceId(runId), 1, 10_000);
  return stored.map((e) => e.event as RunEvent);
}

/**
 * Runs the system without settling, until `done` holds or it stops moving. `kit.settle` waits for
 * every piped promise, so it can't be used while a tool is held open (the spec's open question 9).
 */
export async function drive(kit: TestKit, done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    kit.scheduler.runReady();
    await Promise.resolve();
  }
}

/** Asks the run for its status, driving the system until it replies. */
export async function statusOf(kit: TestKit, ref: ActorRef<RunMsg>): Promise<RunStatus> {
  const probe = kit.probe<RunStatus>(`status-${String(kit.scheduler.now())}-${String(seq++)}`);
  ref.tell({ type: 'status', replyTo: probe.ref });
  let reply: RunStatus | undefined;
  await drive(kit, () => {
    try {
      reply = probe.expectMessage();
      return true;
    } catch {
      return false;
    }
  });
  if (reply === undefined) throw new Error('the run never answered status');
  return reply;
}
let seq = 0;

/** A promise a test settles itself. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A tool that records each call, and answers with `answer`. */
export function recordingTool(
  name: string,
  answer: (input: JsonValue, ctx: ToolContext) => Promise<JsonValue> = () =>
    Promise.resolve({ from: name }),
  idempotent = true,
): { tool: Tool; calls: { input: JsonValue; ctx: ToolContext }[] } {
  const calls: { input: JsonValue; ctx: ToolContext }[] = [];
  return {
    calls,
    tool: tool({
      name,
      description: `The ${name} tool.`,
      input: { type: 'object' },
      idempotent,
      run: (input, ctx) => {
        calls.push({ input, ctx });
        return answer(input, ctx);
      },
    }),
  };
}

// The example's log. Everything it prints comes from the journal: live, as each event is
// appended, and for `--show`, from `readRun`. So what you see is what a recovering run would see.

import type { Persistence } from '@kylewillett/troupe/persistence';
import type {
  JsonValue,
  RunEvent,
  RunTimeline,
  TimelineAttempt,
  ToolResult,
} from '@kylewillett/steadfast';

const WIDTH = 96;

function short(value: JsonValue | string): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > WIDTH ? `${text.slice(0, WIDTH - 1)}…` : text;
}

function tag(step: number): string {
  return `step ${String(step)}`.padEnd(10);
}

function tokens(usage: { inputTokens: number; outputTokens: number }): string {
  return `${usage.inputTokens.toLocaleString('en')} tokens in, ${usage.outputTokens.toLocaleString('en')} out`;
}

function result(r: ToolResult): string {
  if (r.ok) return `ok ${short(r.output)}`;
  return r.interrupted === true ? `INTERRUPTED: ${r.error}` : `error: ${r.error}`;
}

/**
 * One line, or a few, for an event as it's journaled. `names` gives a call id's tool, since a
 * tool's result names only its call.
 */
export function describe(event: RunEvent, names: ReadonlyMap<string, string>): string[] {
  switch (event.type) {
    case 'runStarted':
      return [`started on ${event.model}: ${JSON.stringify(event.input)}`];
    case 'modelResponded': {
      const { response } = event;
      const asks = response.toolCalls.map((c) => c.name).join(', ');
      const lines = [
        `${tag(event.step)}model (${tokens(response.usage)})` + (asks ? ` asks for ${asks}` : ''),
      ];
      if (response.text !== '' && asks) lines.push(`${' '.repeat(10)}"${short(response.text)}"`);
      return lines;
    }
    case 'toolFinished':
      return [
        `${tag(event.step)}${names.get(event.callId) ?? event.callId} ${result(event.result)}`,
      ];
    case 'attemptFailed': {
      const what =
        event.target.kind === 'model'
          ? 'model call'
          : (names.get(event.target.callId) ?? event.target.callId);
      return [`${tag(event.step)}${what} failed: ${event.error.message}. Restarting with backoff.`];
    }
    case 'runFinished':
      return [`finished: ${event.outcome}`, `  ${event.text}`];
  }
}

/** What {@link narrated} watches for. */
export interface Narration {
  /** Tool names by call id, for calls an earlier process journaled. */
  readonly calls?: Iterable<readonly [string, string]>;
  /** Called once every part of step `step` is journaled: its response and each tool result. */
  readonly onStepJournaled?: (step: number) => void;
}

/**
 * Wraps a persistence so every event the run appends is printed once it's stored. Reads pass
 * through untouched, so recovery prints nothing.
 */
export function narrated(base: Persistence, narration: Narration = {}): Persistence {
  // How many tool results each step still waits on, from the events this process has appended.
  const waiting = new Map<number, number>();
  const names = new Map<string, string>(narration.calls);
  const stepDone = (step: number) => narration.onStepJournaled?.(step);
  return {
    ...base,
    journal: {
      ...base.journal,
      read: (id, fromSeq, limit) => base.journal.read(id, fromSeq, limit),
      readByTag: (t, afterOffset, limit) => base.journal.readByTag(t, afterOffset, limit),
      async append(id, expectedSeq, events) {
        await base.journal.append(id, expectedSeq, events);
        for (const { event } of events) {
          const e = event as RunEvent;
          if (e.type === 'modelResponded') {
            for (const call of e.response.toolCalls) names.set(call.id, call.name);
          }
          for (const line of describe(e, names)) console.log(line);
          if (e.type === 'modelResponded') {
            const calls = e.response.toolCalls.length;
            if (calls === 0) stepDone(e.step);
            else waiting.set(e.step, calls);
          } else if (e.type === 'toolFinished') {
            const left = (waiting.get(e.step) ?? 1) - 1;
            waiting.set(e.step, left);
            if (left === 0) stepDone(e.step);
          }
        }
      },
    },
  };
}

function attempts(list: readonly TimelineAttempt[], indent: string): string[] {
  return list.map((a) => `${indent}#${String(a.seq)} attempt failed: ${a.error.message}`);
}

/** A whole run, step by step, from its journal. */
export function printTimeline(runId: string, timeline: RunTimeline): void {
  const { state, events, steps } = timeline;
  if (events.length === 0) {
    console.log(`${runId} has no events. Run the example first.`);
    return;
  }
  const first = events[0]?.event;
  console.log(`${runId}: ${String(events.length)} events`);
  if (first?.type === 'runStarted') {
    console.log(`#1 started by ${first.agent} on ${first.model}: ${JSON.stringify(first.input)}`);
  }
  for (const s of steps) {
    console.log('');
    console.log(`step ${String(s.step)}`);
    for (const line of attempts(s.attempts, '  ')) console.log(line);
    if (s.response !== undefined) {
      const { response } = s;
      console.log(
        `  #${String(s.responseSeq)} ${response.model} said (${response.stop}, ${tokens(response.usage)}):`,
      );
      if (response.text !== '') console.log(`    ${response.text}`);
    }
    for (const call of s.tools) {
      console.log(`  ${call.name} ${short(call.input)}`);
      for (const line of attempts(call.attempts, '    ')) console.log(line);
      console.log(
        call.result === undefined
          ? '    still running'
          : `    #${String(call.resultSeq)} ${result(call.result)}`,
      );
    }
  }
  console.log('');
  if (state.phase === 'finished') {
    console.log(
      `finished: ${String(state.outcome)} after ${String(state.step)} steps, ${tokens(state.usage)}`,
    );
  } else {
    console.log(`not finished: waiting on ${state.pending.kind} at step ${String(state.step)}`);
  }
}

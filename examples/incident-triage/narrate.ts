// The example's log. Everything it prints comes from the run's progress: each event once it's
// journaled, by every run in the tree, and model text as it's written. `--show` prints the same
// tree from the journals, with `readRun`. A sub-run's lines are indented under the step that
// started it.

import {
  readRun,
  type Agent,
  type JsonValue,
  type RunEvent,
  type RunProgress,
  type RunTimeline,
  type TimelineAttempt,
  type TimelineToolCall,
  type ToolResult,
} from '@kylewillett/steadfast';

const WIDTH = 96;
/** How far each level of sub-run is indented: under the text of the step that started it. */
const INDENT = 10;

function short(value: JsonValue | string): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > WIDTH ? `${text.slice(0, WIDTH - 1)}…` : text;
}

function tag(step: number): string {
  return `step ${String(step)}`.padEnd(INDENT);
}

/** A run's indent: one level for each `/` in its id, since a sub-run's id extends its parent's. */
function indentOf(runId: string): string {
  return ' '.repeat(INDENT * (runId.split('/').length - 1));
}

function tokens(usage: { inputTokens: number; outputTokens: number }): string {
  return `${usage.inputTokens.toLocaleString('en')} tokens in, ${usage.outputTokens.toLocaleString('en')} out`;
}

function result(r: ToolResult): string {
  if (r.ok) return `ok ${short(r.output)}`;
  return r.interrupted === true ? `INTERRUPTED: ${r.error}` : `error: ${r.error}`;
}

/** What {@link narrator} watches for. */
export interface NarratorOptions {
  /**
   * Called each time a step of any run in the tree is wholly journaled, its response and every
   * tool result, with how many steps this process has seen finish so far, across the tree.
   */
  readonly onStepFinished?: (count: number) => void;
}

/** Prints a run's progress as it happens. */
export interface Narrator {
  /** What the journal says already, for a run this process resumes, so its calls have names. */
  learn(runId: string, timeline: RunTimeline): void;
  show(progress: RunProgress): void;
  /** Prints a line of the example's own, after any text that's streaming. */
  say(line: string): void;
}

export function narrator(options: NarratorOptions = {}): Narrator {
  // Tool names by run and call id, since a tool's result names only its call.
  const names = new Map<string, string>();
  // How many tool results each run's step still waits on.
  const waiting = new Map<string, number>();
  // Which steps' text has streamed, so it isn't printed again with the response.
  const streamed = new Set<string>();
  let finished = 0;
  // The text line being written, if any, as `runId step attempt`.
  let open: string | undefined;

  const key = (runId: string, step: number) => `${runId} ${String(step)}`;
  const close = () => {
    if (open !== undefined) process.stdout.write('"\n');
    open = undefined;
  };
  const say = (line: string) => {
    close();
    console.log(line);
  };
  const stepFinished = () => options.onStepFinished?.(++finished);

  function journaled(runId: string, event: RunEvent): void {
    const indent = indentOf(runId);
    const out = (line: string) => {
      say(indent + line);
    };
    const name = (callId: string) => names.get(`${runId} ${callId}`) ?? callId;
    switch (event.type) {
      case 'runStarted':
        if (indent === '') out(`started on ${event.model}: ${JSON.stringify(event.input)}`);
        else out(`${event.agent} started on ${event.model}: ${short(JSON.stringify(event.input))}`);
        return;
      case 'modelResponded': {
        const { response, step } = event;
        for (const call of response.toolCalls) names.set(`${runId} ${call.id}`, call.name);
        const asks = response.toolCalls.map((c) => c.name).join(', ');
        out(`${tag(step)}model (${tokens(response.usage)})` + (asks ? ` asks for ${asks}` : ''));
        if (response.text !== '' && asks && !streamed.has(key(runId, step))) {
          out(`${' '.repeat(INDENT)}"${short(response.text)}"`);
        }
        if (response.toolCalls.length === 0) stepFinished();
        else waiting.set(key(runId, step), response.toolCalls.length);
        return;
      }
      case 'toolFinished': {
        out(`${tag(event.step)}${name(event.callId)} ${result(event.result)}`);
        const left = (waiting.get(key(runId, event.step)) ?? 1) - 1;
        waiting.set(key(runId, event.step), left);
        if (left === 0) stepFinished();
        return;
      }
      case 'approvalRequested':
        out(`${tag(event.step)}${event.tool} waits for a person's approval`);
        return;
      case 'approvalDecided': {
        if (event.timedOut === true) {
          out(`${tag(event.step)}${name(event.callId)}: nobody decided in time`);
          return;
        }
        const verdict = event.approved ? 'approved' : 'denied';
        out(`${tag(event.step)}${name(event.callId)} ${verdict} by ${event.by}`);
        return;
      }
      case 'attemptFailed': {
        const what = event.target.kind === 'model' ? 'model call' : name(event.target.callId);
        out(`${tag(event.step)}${what} failed: ${event.error.message}. Restarting with backoff.`);
        return;
      }
      case 'runFinished':
        out(`finished: ${event.outcome}`);
        out(`  ${indent === '' ? event.text : short(event.text)}`);
        return;
    }
  }

  function text(runId: string, step: number, attempt: number, piece: string): void {
    const at = `${runId} ${String(step)} ${String(attempt)}`;
    if (open !== at) {
      close();
      process.stdout.write(`${indentOf(runId)}${' '.repeat(INDENT)}"`);
      open = at;
      streamed.add(key(runId, step));
    }
    process.stdout.write(piece);
  }

  return {
    learn(runId, timeline) {
      for (const s of timeline.steps) {
        for (const call of s.tools) names.set(`${runId} ${call.callId}`, call.name);
        const left = s.tools.filter((t) => t.result === undefined).length;
        if (left > 0) waiting.set(key(runId, s.step), left);
      }
    },
    show(progress) {
      switch (progress.type) {
        case 'journaled':
          journaled(progress.runId, progress.event);
          return;
        case 'text':
          text(progress.runId, progress.step, progress.attempt, progress.text);
          return;
        case 'resumed':
          // The root's resumption is the example's first line. A sub-run's is news.
          if (progress.seq > 0 && progress.runId.includes('/')) {
            say(
              `${indentOf(progress.runId)}${progress.runId} resumes from its journal, ` +
                `at event ${String(progress.seq)}`,
            );
          }
          return;
      }
    },
    say,
  };
}

/** The calls in a run's journal still waiting for a person's decision. */
export function waitingApprovals(timeline: RunTimeline): TimelineToolCall[] {
  if (timeline.state.phase !== 'running') return [];
  return (timeline.steps.at(-1)?.tools ?? []).filter(
    (t) => t.approval !== undefined && t.approval.decision === undefined,
  );
}

function attempts(list: readonly TimelineAttempt[], indent: string): string[] {
  return list.map((a) => `${indent}#${String(a.seq)} attempt failed: ${a.error.message}`);
}

function approvalLine(call: TimelineToolCall): string | undefined {
  const { approval } = call;
  if (approval === undefined) return undefined;
  const asked = `#${String(approval.requestedSeq)} asked for approval`;
  const { decision } = approval;
  if (decision === undefined) return `${asked}, still waiting`;
  if (decision.timedOut === true)
    return `${asked}; #${String(decision.seq)} nobody decided in time`;
  const verdict = decision.approved ? 'approved' : 'denied';
  return `${asked}; #${String(decision.seq)} ${verdict} by ${decision.by}`;
}

/**
 * A run and every sub-run under it, step by step, from their journals. Each sub-run is read with
 * the agent its delegation tool names, and printed under the call that started it.
 */
export async function printTree(agent: Agent, runId: string, indent = ''): Promise<void> {
  const timeline = await readRun(agent, runId);
  const log = (line: string) => {
    console.log(line === '' ? '' : indent + line);
  };
  const { state, events, steps } = timeline;
  if (events.length === 0) {
    log(`${runId} has no events. Run the example first.`);
    return;
  }
  const first = events[0]?.event;
  log(`${runId}: ${String(events.length)} events`);
  if (first?.type === 'runStarted') {
    log(`#1 started by ${first.agent} on ${first.model}: ${short(JSON.stringify(first.input))}`);
  }
  for (const s of steps) {
    log('');
    log(`step ${String(s.step)}`);
    for (const line of attempts(s.attempts, '  ')) log(line);
    if (s.response !== undefined) {
      const { response } = s;
      log(
        `  #${String(s.responseSeq)} ${response.model} said (${response.stop}, ${tokens(response.usage)}):`,
      );
      if (response.text !== '') log(`    ${short(response.text)}`);
    }
    for (const call of s.tools) {
      log(`  ${call.name} ${short(call.input)}`);
      const approval = approvalLine(call);
      if (approval !== undefined) log(`    ${approval}`);
      for (const line of attempts(call.attempts, '    ')) log(line);
      if (call.subRun !== undefined) {
        const sub = agent.tools.find((t) => t.name === call.name)?.delegatesTo;
        if (sub !== undefined) {
          console.log('');
          await printTree(sub, call.subRun.runId, `${indent}    `);
          console.log('');
        }
      }
      log(
        call.result === undefined
          ? '    no result'
          : `    #${String(call.resultSeq)} ${result(call.result)}`,
      );
    }
  }
  log('');
  if (state.phase === 'finished') {
    log(
      `finished: ${String(state.outcome)} after ${String(state.step)} steps, ${tokens(state.usage)}`,
    );
  } else {
    log(`not finished: waiting on ${state.pending.kind} at step ${String(state.step)}`);
  }
}

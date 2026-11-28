// An awaitable handle on a run, for plain async code outside an actor (milestone 1's open question
// 2). It's a convenience over the actor API, never a replacement: a small host actor spawns the
// run as its child, hears its report and progress, and passes on what the caller asks.

import { actor, type ActorRef, type ActorSystem } from '@kylewillett/troupe';
import type { Agent } from './agent.js';
import { ACTOR_NAME } from './run/sub-run.js';
import type { DecideReply, RunLimits, RunMsg, RunProgress, RunReport } from './run/types.js';

/** What {@link startRun} takes. */
export interface StartRunOptions {
  /** The run's input, used only when the journal has no events for the run. */
  readonly input: string;
  /** Limits on top of the agent's budget, as for `agent.run`. */
  readonly limits?: RunLimits;
  /**
   * Called with everything the run's tree tells its `progressTo`, in order. An error it throws is
   * logged and ignored, so a bad listener never stops the run.
   */
  readonly onProgress?: (progress: RunProgress) => void;
}

/** A person's decision on a call waiting for approval: `decide`'s fields, less its reply ref. */
export interface Decision {
  /** The run the call is in, from its `approvalRequested` event: the root or any sub-run. */
  readonly runId: string;
  readonly callId: string;
  readonly approved: boolean;
  /** Who decided, for the journal. */
  readonly by: string;
  readonly note?: string;
}

/** A run started by {@link startRun}. */
export interface RunHandle {
  readonly runId: string;
  /**
   * Settles with the run's first report. Rejects if the run stops without reporting, such as when
   * the system terminates first: the run isn't finished, and spawning it again resumes it.
   */
  readonly done: Promise<RunReport>;
  /**
   * Finishes the run with `cancelled`, and every run under it (decision 0008). With `runId`, only
   * the sub-run it names. Does nothing once `done` has settled.
   * @throws TypeError at once if `reason` or `runId` isn't a string.
   */
  cancel(reason: string, runId?: string): void;
  /**
   * Sends a decision to the run, which forwards it to the sub-run it's for, and resolves with the
   * reply. Resolves `notWaiting` once `done` has settled, since the run has finished.
   * @throws TypeError at once for a decision with a missing, wrong or unknown field.
   */
  decide(decision: Decision): Promise<DecideReply>;
}

type HostMsg =
  | RunReport
  | RunProgress
  | Extract<RunMsg, { readonly type: 'cancel' }>
  | Extract<RunMsg, { readonly type: 'decide' }>;

const KEYS = new Set(['input', 'limits', 'onProgress']);
const DECISION_KEYS = new Set(['runId', 'callId', 'approved', 'by', 'note']);

/** The runs each system is hosting, by stream id, so one journal never has two incarnations. */
const hosted = new WeakMap<ActorSystem, Set<string>>();

/**
 * Starts or resumes run `runId` of `agent` in `system`, and returns a handle to await, cancel and
 * decide it. It spawns a host actor, which spawns the run as its child and stops it once it has
 * reported.
 * @throws TypeError for bad arguments or options, as `agent.run` does.
 * @throws Error if `startRun` is already running this run in `system`.
 */
export function startRun(
  system: ActorSystem,
  agent: Agent,
  runId: string,
  options: StartRunOptions,
): RunHandle {
  const raw: unknown = options;
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError('startRun: give an options object');
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new TypeError(`startRun: unknown option "${key}"`);
  }
  const { input, limits, onProgress } = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('startRun: onProgress must be a function');
  }
  const runOptions = { input, ...(limits === undefined ? {} : { limits }) };
  // agent.run checks the id and options, so a bad one throws here rather than in the host.
  agent.run(runId, runOptions);

  const id = agent.persistenceId(runId);
  const running = hosted.get(system) ?? new Set<string>();
  if (running.has(id)) {
    throw new Error(`startRun: ${id} is already running in system "${system.name}"`);
  }

  let settled = false;
  let resolve: (report: RunReport) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const done = new Promise<RunReport>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A caller who only cancels may never await `done`, and its rejection shouldn't crash them.
  done.catch(() => undefined);

  let run: ActorRef<RunMsg> | undefined;
  const host = actor<HostMsg, null>({
    initial: (ctx) => {
      run = ctx.spawn(
        agent.run(runId, { ...runOptions, reportTo: ctx.self, progressTo: ctx.self }),
        'run',
      );
      ctx.watch(run);
      return null;
    },
    receive: (state, msg, ctx) => {
      switch (msg.type) {
        case 'runFinished':
          // The first report is the answer. The tree has closed by then (decision 0008).
          if (!settled) {
            settled = true;
            resolve(msg);
            ctx.stop();
          }
          return state;
        case 'journaled':
        case 'text':
        case 'resumed':
          try {
            onProgress?.(msg);
          } catch (error) {
            ctx.log.error(`startRun: onProgress threw for ${id}`, { error });
          }
          return state;
        case 'cancel':
        case 'decide':
          run?.tell(msg);
          return state;
      }
    },
    onSignal: (state, signal, ctx) => {
      // The run stopped without reporting, so the host has nothing more to do.
      if (signal.type === 'terminated') ctx.stop();
      if (signal.type === 'postStop') {
        running.delete(id);
        if (!settled) {
          settled = true;
          reject(new Error(`startRun: ${id} stopped before it finished`));
        }
      }
      return state;
    },
  });

  const name = `steadfast-${id}`;
  const ref = system.spawn(host, ACTOR_NAME.test(name) ? name : undefined);
  running.add(id);
  hosted.set(system, running);

  return Object.freeze({
    runId,
    done,
    cancel(reason: string, target?: string) {
      if (typeof reason !== 'string') throw new TypeError('cancel: reason must be a string');
      if (target !== undefined && typeof target !== 'string') {
        throw new TypeError('cancel: runId must be a string');
      }
      if (settled) return;
      ref.tell({ type: 'cancel', reason, ...(target === undefined ? {} : { runId: target }) });
    },
    decide(decision: Decision): Promise<DecideReply> {
      checkDecision(decision);
      if (settled) return Promise.resolve({ ok: false, reason: 'notWaiting' });
      return ref.ask<DecideReply>((replyTo) => ({ type: 'decide', ...decision, replyTo }));
    },
  });
}

function checkDecision(decision: unknown): void {
  if (typeof decision !== 'object' || decision === null) {
    throw new TypeError('decide: give a decision object');
  }
  const d = decision as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (!DECISION_KEYS.has(key)) throw new TypeError(`decide: unknown field "${key}"`);
  }
  for (const key of ['runId', 'callId', 'by'] as const) {
    if (typeof d[key] !== 'string') throw new TypeError(`decide: ${key} must be a string`);
  }
  if (typeof d.approved !== 'boolean') throw new TypeError('decide: approved must be a boolean');
  if (d.note !== undefined && typeof d.note !== 'string') {
    throw new TypeError('decide: note must be a string');
  }
}

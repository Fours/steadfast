// Type tests: the checks happen in `npm run typecheck`, and vitest runs them as no-ops.
import type { ActorDef, ActorRef, JsonValue as TroupeJsonValue } from '@kylewillett/troupe';
import { describe, expectTypeOf, it } from 'vitest';
import {
  inMemoryPersistence,
  type PersistentState,
  type StandardSchemaV1,
} from '@kylewillett/troupe/persistence';
import {
  agent,
  delegate,
  tool,
  type Agent,
  type ApprovalCheck,
  type Budget,
  type DecideReply,
  type PendingApproval,
  type DelegateOptions,
  type RunLimits,
  type TimelineToolCall,
  type JsonValue,
  type Model,
  type ModelCallOptions,
  type ModelRequest,
  type ModelResponse,
  type Outcome,
  type RunEvent,
  type RunMsg,
  type RunOptions,
  type RunProgress,
  type RunReport,
  type RunState,
  type RunStatus,
  type StopReason,
  type Tool,
  type ToolCall,
  type ToolContext,
  type ToolResult,
} from '../src/index.ts';
import { callTool, callTools, pause, say, scriptedModel } from '../src/testkit/index.ts';

function respond(response: ModelResponse): ModelResponse {
  return response;
}

function result(value: ToolResult): ToolResult {
  return value;
}

describe('types', () => {
  it('a model that ignores onText is still a Model', () => {
    type NoOptions = { name: string; call(request: ModelRequest): Promise<ModelResponse> };
    type SignalOnly = {
      name: string;
      call(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelResponse>;
    };
    expectTypeOf<NoOptions>().toExtend<Model>();
    expectTypeOf<SignalOnly>().toExtend<Model>();
    expectTypeOf<ModelCallOptions['onText']>().toEqualTypeOf<
      ((text: string) => void) | undefined
    >();
  });

  it('pause builds a ModelResponse, and paused is a StopReason', () => {
    expectTypeOf(pause()).toEqualTypeOf<ModelResponse>();
    expectTypeOf<'paused'>().toExtend<StopReason>();
    expectTypeOf<ToolCall['inputError']>().toEqualTypeOf<string | undefined>();
  });

  it('say, callTool and callTools build ModelResponses', () => {
    expectTypeOf(say('hi')).toEqualTypeOf<ModelResponse>();
    expectTypeOf(callTool('read_log', { lines: 5 })).toEqualTypeOf<ModelResponse>();
    expectTypeOf(callTools([{ name: 'a', input: [] }])).toEqualTypeOf<ModelResponse>();
  });

  it('a scripted model is a Model', () => {
    expectTypeOf(scriptedModel([])).toExtend<Model>();
  });

  it("JsonValue is Troupe's, so a value that type-checks here is one its journal can hold", () => {
    expectTypeOf<JsonValue>().toEqualTypeOf<TroupeJsonValue>();
  });

  it("a model's raw must be a JsonValue", () => {
    expectTypeOf<ModelResponse['raw']>().toEqualTypeOf<JsonValue>();
    const base = say('hi');
    respond({ ...base, raw: [{ type: 'text', text: 'hi' }, null, 1, true] });
    // @ts-expect-error A Date isn't JSON: it would come back from the journal as a string.
    respond({ ...base, raw: new Date() });
    // @ts-expect-error undefined isn't JSON: the key would vanish from the journal.
    respond({ ...base, raw: undefined });
    // @ts-expect-error A function isn't JSON.
    respond({ ...base, raw: () => 1 });
    // @ts-expect-error Nor is a Map, however deep.
    respond({ ...base, raw: { blocks: [new Map()] } });
  });

  it('a tool call input and a tool output must be JSON values', () => {
    // @ts-expect-error A bigint isn't JSON.
    result({ ok: true, output: 1n });
    // @ts-expect-error undefined isn't JSON.
    callTool('read_log', undefined);
  });

  it("a tool's input type comes from parse, or from run's annotation, and defaults to JsonValue", () => {
    const input = { type: 'object' } as const;
    const schema: StandardSchemaV1<unknown, { service: string; lines: number }> = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [] }) },
    };
    const parsed = tool({
      name: 'read_log',
      description: 'd',
      input,
      parse: schema,
      run: (args, ctx) => {
        expectTypeOf(args).toEqualTypeOf<{ service: string; lines: number }>();
        expectTypeOf(ctx).toEqualTypeOf<ToolContext>();
        return Promise.resolve({ lines: [args.service] });
      },
    });
    expectTypeOf(parsed).toEqualTypeOf<
      Tool<{ service: string; lines: number }, { lines: string[] }>
    >();

    const annotated = tool({
      name: 'a',
      description: 'd',
      input,
      run: (args: { service: string }) => Promise.resolve(args.service),
    });
    expectTypeOf(annotated).toEqualTypeOf<Tool<{ service: string }, string>>();

    const plain = tool({
      name: 'p',
      description: 'd',
      input,
      run: (args) => Promise.resolve(args),
    });
    expectTypeOf(plain).toEqualTypeOf<Tool>();
  });

  it('tools of any input and output fit one list, as an agent takes them', () => {
    const input = { type: 'object' } as const;
    const tools: readonly Tool[] = [
      tool({
        name: 'a',
        description: 'd',
        input,
        run: (args: { n: number }) => Promise.resolve(args.n),
      }),
      tool({ name: 'b', description: 'd', input, run: () => Promise.resolve(['x']) }),
      // A needsApproval function of a narrower input fits too, as run does.
      tool({
        name: 'c',
        description: 'd',
        input,
        needsApproval: (args: { severity: string }) => args.severity === 'sev1',
        run: (args: { severity: string }) => Promise.resolve(args.severity),
      }),
    ];
    expectTypeOf(tools).toExtend<readonly Tool[]>();
  });

  it('needsApproval gets the parsed input, and decide replies with a DecideReply', () => {
    const input = { type: 'object' } as const;
    const schema: StandardSchemaV1<unknown, { severity: 'sev1' | 'sev2' }> = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [] }) },
    };
    tool({
      name: 'page_oncall',
      description: 'd',
      input,
      parse: schema,
      needsApproval: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ severity: 'sev1' | 'sev2' }>();
        return args.severity === 'sev1';
      },
      run: () => Promise.resolve(null),
    });
    expectTypeOf<ApprovalCheck<{ n: number }>>().toEqualTypeOf<(input: { n: number }) => boolean>();
    expectTypeOf<Extract<RunMsg, { type: 'decide' }>['replyTo']>().toEqualTypeOf<
      ActorRef<DecideReply> | undefined
    >();
    expectTypeOf<DecideReply>().toEqualTypeOf<
      { readonly ok: true } | { readonly ok: false; readonly reason: 'notWaiting' | 'unknownRun' }
    >();
    expectTypeOf<RunStatus['approvals']>().toEqualTypeOf<readonly PendingApproval[]>();
  });

  it("a tool's output must be a JSON value", () => {
    const input = { type: 'object' } as const;
    // @ts-expect-error A Date isn't JSON: it would come back from the journal as a string.
    tool({ name: 'a', description: 'd', input, run: () => Promise.resolve(new Date()) });
    // @ts-expect-error Nor is undefined.
    tool({ name: 'b', description: 'd', input, run: () => Promise.resolve(undefined) });
  });

  it('agent.run gives an actor definition for the run protocol, and reports a RunReport', () => {
    const a = agent({
      name: 'triage',
      model: scriptedModel([]),
      system: 's',
      persistence: inMemoryPersistence(),
    });
    expectTypeOf(a).toEqualTypeOf<Agent>();
    expectTypeOf(a.run).returns.toEqualTypeOf<ActorDef<RunMsg, PersistentState<RunState>>>();
    expectTypeOf(a.run).parameter(1).toHaveProperty('reportTo');

    // Never called: these only have to type-check.
    const calls = (reportTo: ActorRef<RunReport>) => {
      a.run('r1', { input: 'go', reportTo });
      // @ts-expect-error A ref for some other protocol can't hear the report.
      a.run('r1', { input: 'go', reportTo: {} as ActorRef<string> });
      // @ts-expect-error The input is text.
      a.run('r1', { input: { text: 'go' } });
    };
    expectTypeOf(calls).toBeFunction();

    expectTypeOf<RunReport>().toEqualTypeOf<{
      readonly type: 'runFinished';
      readonly runId: string;
      readonly outcome: Outcome;
      readonly text: string;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number };
    }>();
  });

  it('progressTo takes a ref that hears RunProgress, and narrowing on type gives its fields', () => {
    const a = agent({
      name: 'triage',
      model: scriptedModel([]),
      system: 's',
      persistence: inMemoryPersistence(),
    });
    expectTypeOf<RunOptions['progressTo']>().toEqualTypeOf<ActorRef<RunProgress> | undefined>();

    // Never called: these only have to type-check.
    const calls = (host: ActorRef<RunProgress | RunReport>) => {
      // One actor can hear a run's report and its progress, as a host or a UI would.
      a.run('r1', { input: 'go', reportTo: host, progressTo: host });
      // @ts-expect-error A ref for some other protocol can't hear progress.
      a.run('r1', { input: 'go', progressTo: {} as ActorRef<string> });
    };
    expectTypeOf(calls).toBeFunction();

    const narrow = (p: RunProgress) => {
      switch (p.type) {
        case 'journaled':
          expectTypeOf(p.event).toEqualTypeOf<RunEvent>();
          expectTypeOf(p.seq).toEqualTypeOf<number>();
          break;
        case 'text':
          expectTypeOf(p.attempt).toEqualTypeOf<number>();
          expectTypeOf(p.text).toEqualTypeOf<string>();
          break;
        case 'resumed':
          expectTypeOf(p.seq).toEqualTypeOf<number>();
          break;
      }
      expectTypeOf(p.runId).toEqualTypeOf<string>();
    };
    expectTypeOf(narrow).toBeFunction();
  });

  it('status takes a ref for RunStatus', () => {
    expectTypeOf<Extract<RunMsg, { type: 'status' }>['replyTo']>().toEqualTypeOf<
      ActorRef<RunStatus>
    >();
  });

  it('delegate makes a Tool from an Agent, and a run hears its sub-runs’ reports', () => {
    const analyst = agent({
      name: 'log-analyst',
      model: scriptedModel([]),
      system: 's',
      persistence: inMemoryPersistence(),
    });
    expectTypeOf(delegate(analyst, { description: 'd' })).toEqualTypeOf<Tool>();
    expectTypeOf<Tool['delegatesTo']>().toEqualTypeOf<Agent | undefined>();
    expectTypeOf<DelegateOptions>().toEqualTypeOf<{
      readonly name?: string;
      readonly description: string;
      readonly needsApproval?: boolean | ApprovalCheck<{ readonly task: string }>;
      readonly approvalTimeoutMs?: number;
    }>();
    // @ts-expect-error A description is required.
    expectTypeOf(() => delegate(analyst, {})).toBeFunction();

    // A run is its sub-runs' `reportTo`, so its protocol takes their reports.
    expectTypeOf<RunReport>().toExtend<RunMsg>();
    expectTypeOf<ActorRef<RunMsg>>().toExtend<ActorRef<RunReport>>();

    expectTypeOf<RunOptions['limits']>().toEqualTypeOf<RunLimits | undefined>();
    expectTypeOf<RunLimits>().toEqualTypeOf<{
      readonly deadlineAt?: number;
      readonly maxTokens?: number;
      readonly depthLeft?: number;
    }>();
    expectTypeOf<Budget['maxDepth']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<RunState['treeUsage']>().toEqualTypeOf<RunState['usage']>();
    expectTypeOf<TimelineToolCall['subRun']>().toEqualTypeOf<
      { readonly agent: string; readonly runId: string } | undefined
    >();
  });
});

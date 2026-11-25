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
  tool,
  type Agent,
  type JsonValue,
  type Model,
  type ModelCallOptions,
  type ModelRequest,
  type ModelResponse,
  type Outcome,
  type RunMsg,
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
    ];
    expectTypeOf(tools).toExtend<readonly Tool[]>();
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
    }>();
  });

  it('status takes a ref for RunStatus', () => {
    expectTypeOf<Extract<RunMsg, { type: 'status' }>['replyTo']>().toEqualTypeOf<
      ActorRef<RunStatus>
    >();
  });
});

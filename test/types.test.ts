// Type tests: the checks happen in `npm run typecheck`, and vitest runs them as no-ops.
import type { JsonValue as TroupeJsonValue } from '@kylewillett/troupe';
import { describe, expectTypeOf, it } from 'vitest';
import type { JsonValue, Model, ModelResponse, ToolResult } from '../src/index.ts';
import { callTool, callTools, say, scriptedModel } from '../src/testkit/index.ts';

function respond(response: ModelResponse): ModelResponse {
  return response;
}

function result(value: ToolResult): ToolResult {
  return value;
}

describe('types', () => {
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
});

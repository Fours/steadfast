// Type tests: the checks happen in `npm run typecheck`, and vitest runs them as no-ops.
import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import { describe, expectTypeOf, it } from 'vitest';
import {
  openaiModel,
  type OpenAIClient,
  type OpenAIEffort,
  type OpenAIEventStream,
  type OpenAIModelOptions,
  type OpenAIResponse,
} from '../../src/openai/index.ts';
import type { Model } from '../../src/index.ts';

describe('openai types', () => {
  it('the real SDK client fits the structural client type', () => {
    expectTypeOf<OpenAI>().toExtend<OpenAIClient>();
    // Both of the SDK's results fit: the response, and the stream of events.
    expectTypeOf<OpenAI.Responses.Response>().toExtend<OpenAIResponse>();
    expectTypeOf<
      import('openai/core/streaming').Stream<OpenAI.Responses.ResponseStreamEvent>
    >().toExtend<OpenAIEventStream>();
    // Every effort the adapter takes is one the SDK sends.
    expectTypeOf<OpenAIEffort>().toExtend<NonNullable<ReasoningEffort>>();
    // Constructed without calling it: the type is what's under test.
    const make = () => openaiModel({ client: new OpenAI({ apiKey: 'unused' }), model: 'gpt-5.6' });
    expectTypeOf(make).returns.toEqualTypeOf<Model>();
  });

  it('options are typed, and model is required', () => {
    expectTypeOf<OpenAIModelOptions['model']>().toEqualTypeOf<string>();
    expectTypeOf<OpenAIModelOptions['stream']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<OpenAIModelOptions['effort']>().toEqualTypeOf<OpenAIEffort | undefined>();
    const noModel = () =>
      // @ts-expect-error: there's no default model.
      openaiModel({ client: new OpenAI({ apiKey: 'unused' }) });
    expectTypeOf(noModel).toBeFunction();
    const bad = () =>
      // @ts-expect-error: a client without responses.create doesn't fit.
      openaiModel({ client: { chat: { completions: {} } }, model: 'gpt-5.6' });
    expectTypeOf(bad).toBeFunction();
  });
});

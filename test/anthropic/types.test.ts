// Type tests: the checks happen in `npm run typecheck`, and vitest runs them as no-ops.
import Anthropic from '@anthropic-ai/sdk';
import { describe, expectTypeOf, it } from 'vitest';
import {
  anthropicModel,
  type AnthropicClient,
  type AnthropicMessageStream,
  type AnthropicModelOptions,
  type AnthropicServerTool,
} from '../../src/anthropic/index.ts';
import type { Model } from '../../src/index.ts';

describe('anthropic types', () => {
  it('the real SDK client fits the structural client type, stream included', () => {
    expectTypeOf<Anthropic>().toExtend<AnthropicClient>();
    expectTypeOf<Anthropic['beta']['messages']['stream']>().toExtend<
      AnthropicClient['beta']['messages']['stream']
    >();
    // The SDK's stream object fits the members the adapter uses.
    expectTypeOf<
      ReturnType<Anthropic['beta']['messages']['stream']>
    >().toExtend<AnthropicMessageStream>();
    // Constructed without calling it: the type is what's under test.
    const make = () => anthropicModel({ client: new Anthropic({ apiKey: 'unused' }) });
    expectTypeOf(make).returns.toEqualTypeOf<Model>();
  });

  it('options are typed', () => {
    expectTypeOf<AnthropicModelOptions['fallbacks']>().toEqualTypeOf<
      'default' | false | undefined
    >();
    expectTypeOf<AnthropicModelOptions['effort']>().toEqualTypeOf<
      'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
    >();
    expectTypeOf<AnthropicModelOptions['stream']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<AnthropicModelOptions['serverTools']>().toEqualTypeOf<
      readonly AnthropicServerTool[] | undefined
    >();
    const bad = () =>
      // @ts-expect-error: a client without beta.messages.create doesn't fit.
      anthropicModel({ client: { messages: { create: () => Promise.resolve() } } });
    expectTypeOf(bad).toBeFunction();
    const noStream = (create: Anthropic['beta']['messages']['create']) =>
      // @ts-expect-error: a client without beta.messages.stream doesn't fit.
      anthropicModel({ client: { beta: { messages: { create } } } });
    expectTypeOf(noStream).toBeFunction();
    const untyped = () =>
      // @ts-expect-error: a server tool needs a type.
      anthropicModel({ client: new Anthropic({ apiKey: 'unused' }), serverTools: [{ name: 'x' }] });
    expectTypeOf(untyped).toBeFunction();
  });
});

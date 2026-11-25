// Type tests: the checks happen in `npm run typecheck`, and vitest runs them as no-ops.
import Anthropic from '@anthropic-ai/sdk';
import { describe, expectTypeOf, it } from 'vitest';
import {
  anthropicModel,
  type AnthropicClient,
  type AnthropicModelOptions,
} from '../../src/anthropic/index.ts';
import type { Model } from '../../src/index.ts';

describe('anthropic types', () => {
  it('the real SDK client fits the structural client type', () => {
    expectTypeOf<Anthropic>().toExtend<AnthropicClient>();
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
    const bad = () =>
      // @ts-expect-error: a client without beta.messages.create doesn't fit.
      anthropicModel({ client: { messages: { create: () => Promise.resolve() } } });
    expectTypeOf(bad).toBeFunction();
  });
});

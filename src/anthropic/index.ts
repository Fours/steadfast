// The public API of @kylewillett/steadfast/anthropic: the adapter for Anthropic's Messages API.
// It never imports @anthropic-ai/sdk, which is an optional peer: pass your own client.
export type {
  AnthropicClient,
  AnthropicCreateParams,
  AnthropicMessage,
  AnthropicMessageStream,
  AnthropicMessageParam,
  AnthropicRequestOptions,
} from './client.js';
export {
  anthropicModel,
  type AnthropicEffort,
  type AnthropicModelOptions,
  type AnthropicServerTool,
  type AnthropicThinking,
} from './model.js';

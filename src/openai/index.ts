// The public API of @kylewillett/steadfast/openai: the adapter for OpenAI's Responses API.
// It never imports openai, which is an optional peer: pass your own client.
export type {
  OpenAIClient,
  OpenAICreateParams,
  OpenAIEventStream,
  OpenAIRequestOptions,
  OpenAIResponse,
  OpenAIStreamEvent,
} from './client.js';
export { openaiModel, type OpenAIEffort, type OpenAIModelOptions } from './model.js';

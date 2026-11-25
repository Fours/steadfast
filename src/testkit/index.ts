// The /testkit entry point: scripted and faulty models for tests on Troupe's virtual time.
export { badRequest, overloaded, rateLimited, timedOut } from './errors.js';
export { faultyModel, type Fault } from './faulty-model.js';
export {
  callTool,
  callTools,
  pause,
  say,
  type CallToolOptions,
  type CallToolsOptions,
  type ResponseOptions,
  type ScriptedToolCall,
} from './responses.js';
export {
  scriptedModel,
  type ScriptedModel,
  type ScriptedModelOptions,
  type ScriptEntry,
} from './scripted-model.js';

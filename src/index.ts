// The public API of @kylewillett/steadfast. Export only from here and testkit/index.ts.
// Milestone 1 fills it in task by task: see docs/milestone-1.md.
export type { JsonValue } from './json.js';
export {
  ModelError,
  type JsonSchemaObject,
  type Model,
  type ModelErrorOptions,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCall,
  type ToolResult,
  type ToolSpec,
  type Turn,
  type Usage,
} from './model.js';
export { RetryableToolError, tool, type Tool, type ToolContext, type ToolDef } from './tool.js';
export {
  agent,
  type Agent,
  type AgentOptions,
  type Budget,
  type CheckedBudget,
  type RunOptions,
} from './agent.js';
export type {
  ModelCallReport,
  ModelFailed,
  ModelReplied,
  Outcome,
  Pending,
  RunEvent,
  RunMsg,
  RunReport,
  RunState,
  RunStatus,
  StepError,
  StepTarget,
} from './run/types.js';
export type { AttemptFailed, ToolCallReport, ToolReturned } from './steps/messages.js';
export {
  readRun,
  type ReadRunOptions,
  type RunTimeline,
  type TimelineAttempt,
  type TimelineEvent,
  type TimelineStep,
  type TimelineToolCall,
} from './read-run.js';

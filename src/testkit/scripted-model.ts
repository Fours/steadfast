// A model that answers from a script, for tests that never call a real model.

import type { Model, ModelRequest, ModelResponse } from '../model.js';
import { ModelError } from '../model.js';

/** One answer: a response, or a function of the request and the call's number, from 1. */
export type ScriptEntry =
  ModelResponse | ((request: ModelRequest, call: number) => ModelResponse | Promise<ModelResponse>);

/** Options for {@link scriptedModel}. */
export interface ScriptedModelOptions {
  /** The model's name, recorded in `runStarted`. Default `'scripted'`. */
  readonly name?: string;
}

/** A {@link Model} that answers from a script, and records what it was asked. */
export interface ScriptedModel extends Model {
  /** Every request, in the order it came, including any past the end of the script. */
  readonly requests: readonly ModelRequest[];
}

/**
 * `text` in the pieces a stream would send: each word with the whitespace after it, so the pieces
 * join back into exactly `text`. Whitespace before the first word goes with it.
 */
function wordsOf(text: string): string[] {
  // Text that's all whitespace is one piece, so the pieces always join back into the text.
  return text.match(/\s*\S+\s*|\s+/g) ?? [];
}

/**
 * A model that answers each call with the next entry of `script`. It streams each response's text
 * to `onText` a word at a time, with no delay, before it answers, so tests see streamed text on
 * virtual time. A call past the end throws a {@link ModelError} that isn't retryable, so a run
 * that calls the model more than expected ends `failed` and its test notices.
 */
export function scriptedModel(
  script: readonly ScriptEntry[],
  options: ScriptedModelOptions = {},
): ScriptedModel {
  const entries = [...script];
  const requests: ModelRequest[] = [];
  return {
    name: options.name ?? 'scripted',
    requests,
    async call(request, { onText }) {
      requests.push(request);
      const call = requests.length;
      const entry = entries[call - 1];
      if (entry === undefined) {
        throw new ModelError(
          `scriptedModel: call ${String(call)}, but the script has ${String(entries.length)} entries`,
          { retryable: false },
        );
      }
      const response = typeof entry === 'function' ? await entry(request, call) : entry;
      if (onText !== undefined) for (const piece of wordsOf(response.text)) onText(piece);
      return response;
    },
  };
}

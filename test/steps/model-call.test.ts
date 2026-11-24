import { supervise, type ActorRef, type SystemEvent } from '@kylewillett/troupe';
import { createTestKit, type TestKit, type TestProbe } from '@kylewillett/troupe/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ModelError,
  type Model,
  type ModelCallReport,
  type ModelRequest,
  type ModelResponse,
} from '../../src/index.ts';
import { modelCall, type ModelCallMsg } from '../../src/steps/model-call.ts';
import { badRequest, rateLimited, say } from '../../src/testkit/index.ts';

const backoff = supervise.restartWithBackoff({ minMs: 1_000, maxMs: 60_000, randomFactor: 0.2 });
const PAST_BACKOFF = 10_000;
const request: ModelRequest = {
  system: 'You triage.',
  transcript: [{ role: 'user', text: 'Checkout is down.' }],
  tools: [],
};

let kit: TestKit;

beforeEach(() => {
  kit = createTestKit();
});

afterEach(async () => {
  await kit.shutdown();
});

/** A model whose calls answer in turn from `answers`, recording each call's signal. */
function modelOf(
  ...answers: ((signal: AbortSignal) => Promise<ModelResponse>)[]
): Model & { signals: AbortSignal[]; requests: ModelRequest[] } {
  const signals: AbortSignal[] = [];
  const requests: ModelRequest[] = [];
  return {
    name: 'test-model',
    signals,
    requests,
    call(req, signal) {
      signals.push(signal);
      requests.push(req);
      const answer = answers[signals.length - 1];
      if (answer === undefined) throw new Error('no more answers');
      return answer(signal);
    },
  };
}

function start(model: Model): { parent: TestProbe<ModelCallReport>; ref: ActorRef<ModelCallMsg> } {
  const parent = kit.probe<ModelCallReport>('run');
  const ref = kit.system.spawn(
    modelCall({ model, request, step: 2, replyTo: parent.ref }),
    'model-2',
    { supervision: backoff },
  );
  parent.watch(ref);
  return { parent, ref };
}

function eventsOf<T extends SystemEvent['type']>(type: T): Extract<SystemEvent, { type: T }>[] {
  return kit.events.filter((e): e is Extract<SystemEvent, { type: T }> => e.type === type);
}

describe('the model-call child', () => {
  it('tells its parent the response, then stops', async () => {
    const answer = say('Found it.');
    const model = modelOf(() => Promise.resolve(answer));
    const { parent, ref } = start(model);
    await kit.settle();
    parent.expectMessage({ type: 'modelReplied', step: 2, response: answer });
    parent.expectNoMessage();
    parent.expectTerminated(ref);
    expect(model.requests).toEqual([request]);
    // Its signal is aborted as it stops, so nothing it started keeps running.
    expect(model.signals[0]?.aborted).toBe(true);
  });

  it('reports a retryable failure, then throws so supervision calls again', async () => {
    const answer = say('Second time.');
    const model = modelOf(
      () => Promise.reject(rateLimited()),
      () => Promise.resolve(answer),
    );
    const { parent, ref } = start(model);
    await kit.settle();
    parent.expectMessage({
      type: 'attemptFailed',
      step: 2,
      target: { kind: 'model' },
      error: { message: rateLimited().message },
    });
    expect(eventsOf('failed').map((e) => e.directive)).toEqual(['restart']);
    await kit.advance(PAST_BACKOFF);
    expect(eventsOf('restarted')).toHaveLength(1);
    expect(model.signals[0]?.aborted).toBe(true);
    parent.expectMessage({ type: 'modelReplied', step: 2, response: answer });
    parent.expectTerminated(ref);
  });

  it.each([
    [
      'a ModelError that isn’t retryable',
      () => badRequest('Bad request (400)'),
      'Bad request (400)',
    ],
    ['an error that isn’t a ModelError', () => new TypeError('oops'), 'oops'],
    ['a thrown value that isn’t an Error', () => 'just a string', 'just a string'],
  ])('reports %s without retrying', async (_name, error, message) => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const model = modelOf(() => Promise.reject(error()));
    const { parent, ref } = start(model);
    await kit.advance(PAST_BACKOFF);
    parent.expectMessage({ type: 'modelFailed', step: 2, error: { message } });
    parent.expectNoMessage();
    parent.expectTerminated(ref);
    expect(eventsOf('restarted')).toEqual([]);
  });

  it('reports a call that throws before it returns a promise', async () => {
    const model: Model = {
      name: 'test-model',
      call() {
        throw new ModelError('Refused at once', { retryable: false });
      },
    };
    const { parent, ref } = start(model);
    await kit.settle();
    parent.expectMessage({ type: 'modelFailed', step: 2, error: { message: 'Refused at once' } });
    parent.expectTerminated(ref);
  });

  it("reports a response that isn't JSON, so it never reaches the journal", async () => {
    const bad = { ...say('hi'), raw: { at: new Date(0) } } as unknown as ModelResponse;
    const model = modelOf(() => Promise.resolve(bad));
    const { parent, ref } = start(model);
    await kit.settle();
    parent.expectMessage({
      type: 'modelFailed',
      step: 2,
      error: {
        message:
          "test-model returned a response that isn't JSON: $.raw.at is not a plain object (Date)",
      },
    });
    parent.expectTerminated(ref);
  });

  it('aborts its signal when it is stopped mid-call', async () => {
    // Like a real client, it gives up when its signal is aborted.
    const model = modelOf(
      (signal) =>
        new Promise<ModelResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
          });
        }),
    );
    const { parent, ref } = start(model);
    for (let i = 0; i < 20; i++) {
      kit.scheduler.runReady();
      await Promise.resolve();
    }
    expect(model.signals[0]?.aborted).toBe(false);
    kit.system.stop(ref);
    for (let i = 0; i < 20; i++) {
      kit.scheduler.runReady();
      await Promise.resolve();
    }
    expect(model.signals[0]?.aborted).toBe(true);
    parent.expectNoMessage();
    parent.expectTerminated(ref);
  });
});

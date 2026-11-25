// What the scripted model says at each step, so the example runs with no API key. Step 2's first
// attempt is rate limited, so the log shows the model call restarting with backoff.

import type { Model, ModelRequest, Turn } from '@kylewillett/steadfast';
import {
  callTool,
  callTools,
  faultyModel,
  rateLimited,
  say,
  scriptedModel,
  type ScriptEntry,
} from '@kylewillett/steadfast/testkit';

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

const CAUSE =
  'The cause is the payments v2.14.0 deploy at 14:02, which cut its database pool from 50 ' +
  'connections to 5. Payments now times out waiting for a connection, and checkout returns 502s.';

/** Whether the last batch of tool results says a call was interrupted. */
function pageInterrupted(request: ModelRequest): boolean {
  const last: Turn | undefined = request.transcript.at(-1);
  return (
    last?.role === 'toolResults' &&
    last.results.some((r) => !r.result.ok && r.result.interrupted === true)
  );
}

/** One entry per step, from step 1. */
export const SCRIPT: readonly ScriptEntry[] = [
  callTools(
    [
      { name: 'read_log', input: { service: 'checkout', lines: 20 }, id: 'toolu_01' },
      {
        name: 'query_metrics',
        input: { service: 'checkout', metric: 'http_5xx_rate' },
        id: 'toolu_02',
      },
    ],
    { text: "I'll start with checkout's log and its error rate.", usage: usage(1_210, 96) },
  ),
  callTool(
    'read_log',
    { service: 'payments', lines: 20 },
    { id: 'toolu_03', text: 'The 502s are timeouts from payments.', usage: usage(1_630, 58) },
  ),
  callTool(
    'query_metrics',
    { service: 'payments-db', metric: 'active_connections' },
    {
      id: 'toolu_04',
      text: 'The deploy shrank the pool. Checking the database.',
      usage: usage(2_050, 61),
    },
  ),
  callTool(
    'page_oncall',
    {
      team: 'payments',
      summary: 'Checkout 502s since 14:03: payments v2.14.0 cut db.pool.max to 5. Roll back.',
    },
    { id: 'toolu_05', text: 'Confirmed. Paging payments.', usage: usage(2_400, 84) },
  ),
  // The model decides what to do about a page that may or may not have gone out.
  (request) =>
    pageInterrupted(request)
      ? say(
          `${CAUSE} I couldn't confirm the page to payments went out, and didn't send it again, ` +
            'so nobody is woken twice. Check the pager before paging again. Next: roll back v2.14.0.',
          { usage: usage(2_560, 120) },
        )
      : say(`${CAUSE} Payments on-call is paged. Next: roll back v2.14.0.`, {
          usage: usage(2_560, 92),
        }),
];

/**
 * The scripted model for a run that has answered `answered` steps. A scripted model answers in
 * order, so a resumed run starts its script where the journal left off.
 */
export function scriptedTriage(answered: number): Model {
  return faultyModel(scriptedModel(SCRIPT.slice(answered)), {
    step: 2,
    fail: [rateLimited({ retryAfterMs: 1_500 })],
  });
}

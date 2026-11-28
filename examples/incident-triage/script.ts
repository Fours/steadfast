// What the scripted models say at each step, so the example runs with no API key. The triage
// agent hands log reading to the log analyst at step 2, and its step 3 model call is rate limited
// once, so the log shows it restarting with backoff.

import type { Model, ModelRequest, Turn } from '@kylewillett/steadfast';
import {
  callTool,
  faultyModel,
  rateLimited,
  say,
  scriptedModel,
  type ScriptEntry,
} from '@kylewillett/steadfast/testkit';

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

/** The task the triage agent gives the log analyst. */
export const ANALYST_TASK =
  "Read the checkout and payments logs since 14:00. Say what's failing, since when, and why. " +
  'Quote the lines that matter.';

const CAUSE =
  'The cause is the payments v2.14.0 deploy at 14:02, which cut its database pool from 50 ' +
  'connections to 5. Payments now times out waiting for a connection, and checkout returns 502s.';

/** How the page went, from the last batch of tool results. */
function pageOutcome(request: ModelRequest): 'sent' | 'denied' | 'interrupted' {
  const last: Turn | undefined = request.transcript.at(-1);
  const result = last?.role === 'toolResults' ? last.results[0]?.result : undefined;
  if (result === undefined || result.ok) return 'sent';
  return result.interrupted === true ? 'interrupted' : 'denied';
}

/** The triage agent's answers, one per step, from step 1. */
export const TRIAGE: readonly ScriptEntry[] = [
  callTool(
    'query_metrics',
    { service: 'checkout', metric: 'http_5xx_rate' },
    { id: 'toolu_01', text: "I'll start with checkout's error rate.", usage: usage(1_210, 64) },
  ),
  callTool(
    'ask_log_analyst',
    { task: ANALYST_TASK },
    {
      id: 'toolu_02',
      text: 'Errors jumped about 15 minutes ago. Asking the log analyst what the logs say.',
      usage: usage(1_480, 88),
    },
  ),
  callTool(
    'query_metrics',
    { service: 'payments-db', metric: 'active_connections' },
    {
      id: 'toolu_03',
      text: 'The analyst says the deploy shrank the pool. Checking the database.',
      usage: usage(2_050, 61),
    },
  ),
  callTool(
    'page_oncall',
    {
      team: 'payments',
      summary: 'Checkout 502s since 14:03: payments v2.14.0 cut db.pool.max to 5. Roll back.',
    },
    { id: 'toolu_04', text: 'Confirmed. Paging payments.', usage: usage(2_400, 84) },
  ),
  // The model decides what to say about the page: sent, denied, or maybe sent.
  (request) => {
    switch (pageOutcome(request)) {
      case 'sent':
        return say(`${CAUSE} Payments on-call is paged. Next: roll back v2.14.0.`, {
          usage: usage(2_560, 92),
        });
      case 'denied':
        return say(
          `${CAUSE} I didn't page payments, because the page was denied. Next: roll back ` +
            'v2.14.0, and tell payments some other way.',
          { usage: usage(2_560, 104) },
        );
      case 'interrupted':
        return say(
          `${CAUSE} I couldn't confirm the page to payments went out, and didn't send it again, ` +
            'so nobody is woken twice. Check the pager before paging again. Next: roll back v2.14.0.',
          { usage: usage(2_560, 120) },
        );
    }
  },
];

/** The log analyst's answers, one per step, from step 1. */
export const ANALYST: readonly ScriptEntry[] = [
  callTool(
    'read_log',
    { service: 'checkout', lines: 20 },
    { id: 'toolu_a1', text: "Checkout's log first.", usage: usage(620, 41) },
  ),
  callTool(
    'read_log',
    { service: 'payments', lines: 20 },
    {
      id: 'toolu_a2',
      text: 'The 502s are timeouts from payments. Reading its log.',
      usage: usage(910, 52),
    },
  ),
  say(
    'Checkout has returned 502s since 14:03:12 ("POST /checkout 502 upstream=payments ' +
      'latency=30001ms"), all timeouts from payments. Payments deployed v2.14.0 at 14:02:01 ' +
      '("db.pool.max 50 -> 5"), and has timed out waiting for a database connection since ' +
      '14:03:02 ("timed out after 30000ms waiting for a connection").',
    { usage: usage(1_340, 118) },
  ),
];

/**
 * The scripted models for runs that have answered `triage` and `analyst` steps. A scripted model
 * answers in order, so a resumed run's script starts where its journal left off.
 */
export function scriptedModels(answered: { triage: number; analyst: number }): {
  triage: Model;
  analyst: Model;
} {
  return {
    triage: faultyModel(scriptedModel(TRIAGE.slice(answered.triage)), {
      step: 3,
      fail: [rateLimited({ retryAfterMs: 1_500 })],
    }),
    analyst: scriptedModel(ANALYST.slice(answered.analyst)),
  };
}

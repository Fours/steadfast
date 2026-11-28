// The example's tools, over a fake checkout outage: a payments deploy at 14:02 shrank the database
// connection pool, payments started timing out, and checkout returns 502s. Reading logs and
// metrics is safe to repeat. Paging someone isn't, so it needs a person's approval too.

import { tool, type Tool } from '@kylewillett/steadfast';

const LOGS: Record<string, readonly string[]> = {
  checkout: [
    '14:03:12 ERROR POST /checkout 502 upstream=payments latency=30001ms',
    '14:03:14 ERROR POST /checkout 502 upstream=payments latency=30002ms',
    '14:03:15 WARN  payments client: circuit half-open after 12 timeouts',
    '14:03:19 ERROR POST /checkout 502 upstream=payments latency=30000ms',
  ],
  payments: [
    '14:02:01 INFO  deploy payments v2.14.0 (db.pool.max 50 -> 5)',
    '14:02:40 WARN  db pool: waited 4800ms for a connection',
    '14:03:02 ERROR db pool: timed out after 30000ms waiting for a connection',
    '14:03:09 ERROR POST /charge 504 reason=db_pool_timeout',
  ],
  'payments-db': ['14:03:30 LOG  connections: 5 of max_connections 400, all from payments'],
};

const METRICS: Record<string, Record<string, readonly number[]>> = {
  checkout: { http_5xx_rate: [0.001, 0.002, 0.001, 0.31, 0.44, 0.47] },
  payments: { p99_latency_ms: [180, 175, 190, 30_000, 30_000, 30_000] },
  'payments-db': { active_connections: [48, 47, 50, 5, 5, 5] },
};

// Types, not interfaces: an interface has no index signature, so it isn't a JsonValue.
type LogInput = {
  readonly service: string;
  readonly lines: number;
};

type MetricsInput = {
  readonly service: string;
  readonly metric: string;
};

type PageInput = {
  readonly team: string;
  readonly summary: string;
};

/** What the example can do to its own tools, to show a crash in the middle of one. */
export interface ToolOptions {
  /** Called inside `page_oncall`, after the page has gone out and before it returns. */
  readonly afterPage?: () => void;
}

/** The example's tools: the log analyst's `readLog`, and the triage agent's other two. */
export interface Tools {
  readonly readLog: Tool;
  readonly queryMetrics: Tool;
  readonly pageOncall: Tool;
}

/** The example's tools. */
export function exampleTools(options: ToolOptions = {}): Tools {
  const readLog = tool({
    name: 'read_log',
    description: 'Read the last lines of a service log.',
    input: {
      type: 'object',
      properties: { service: { type: 'string' }, lines: { type: 'integer', minimum: 1 } },
      required: ['service', 'lines'],
      additionalProperties: false,
    },
    idempotent: true,
    timeoutMs: 10_000,
    run: ({ service, lines }: LogInput) =>
      Promise.resolve({ service, lines: (LOGS[service] ?? []).slice(-lines) }),
  });

  const queryMetrics = tool({
    name: 'query_metrics',
    description: "A service metric's last six five-minute averages, oldest first.",
    input: {
      type: 'object',
      properties: { service: { type: 'string' }, metric: { type: 'string' } },
      required: ['service', 'metric'],
      additionalProperties: false,
    },
    idempotent: true,
    timeoutMs: 10_000,
    run: ({ service, metric }: MetricsInput) => {
      const values = METRICS[service]?.[metric];
      if (values === undefined) throw new Error(`No metric ${metric} for ${service}.`);
      return Promise.resolve({ service, metric, values: [...values] });
    },
  });

  const pageOncall = tool({
    name: 'page_oncall',
    description: "Page a team's on-call engineer. Each call sends a new page.",
    input: {
      type: 'object',
      properties: { team: { type: 'string' }, summary: { type: 'string' } },
      required: ['team', 'summary'],
      additionalProperties: false,
    },
    // A person approves each page before it goes out, and has ten minutes to decide. The run's
    // deadline is fifteen, so a page nobody answers still leaves the model time to say so.
    needsApproval: true,
    approvalTimeoutMs: 10 * 60_000,
    // Not idempotent: a page sent twice wakes someone twice. After a crash it isn't run again,
    // and the model is told it may or may not have gone out.
    run: ({ team, summary }: PageInput, { idempotencyKey }) => {
      console.log(`            >> PAGE to ${team} on-call: ${summary}`);
      options.afterPage?.();
      return Promise.resolve({ paged: team, pageId: idempotencyKey });
    },
  });

  return { readLog, queryMetrics, pageOncall };
}

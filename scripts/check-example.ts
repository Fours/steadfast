// Runs examples/incident-triage on the scripted models, crashes and resumes included, and checks
// that each path ends as it should. CI runs it after the build: `npm run example:check`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../examples/incident-triage/main.ts', import.meta.url));
const CRASHED = 137;
const ANALYST = 'incident-4211/2.0';

interface Run {
  readonly status: number | null;
  readonly out: string;
}

function example(...args: string[]): Run {
  // Node 22 warns that node:sqlite is experimental. It's noise here.
  const run = spawnSync(process.execPath, ['--no-warnings', MAIN, ...args], { encoding: 'utf8' });
  if (run.stderr !== '') process.stderr.write(run.stderr);
  return { status: run.status, out: run.stdout };
}

/** The text the root run finished with, from the narration. */
function finalText(out: string): string | undefined {
  const lines = out.split('\n');
  const at = lines.indexOf('finished: completed');
  return at === -1 ? undefined : lines[at + 1]?.trim();
}

/** The root's steps whose model responses the narration shows, in order. */
function rootResponses(out: string): number[] {
  return [...out.matchAll(/^step (\d+) +model \(/gm)].map((m) => Number(m[1]));
}

/** The log analyst's steps whose model responses the narration shows, in order. */
function analystResponses(out: string): number[] {
  return [...out.matchAll(/^ {10}step (\d+) +model \(/gm)].map((m) => Number(m[1]));
}

/** The narration's lines for each event of every run in the tree: what was journaled, in order. */
function narration(out: string): string[] {
  return out.split('\n').filter((line) => /^ *(step \d+ |finished: )/.test(line));
}

function pages(out: string): number {
  return out.match(/>> PAGE/g)?.length ?? 0;
}

function check(name: string, body: () => void): void {
  body();
  console.log(`ok - ${name}`);
}

let baseline: string | undefined;
let baselineLog: string[] = [];

check('an approved run completes, with the analyst under step 2 and a rate-limited call', () => {
  const run = example('--reset', '--approve', 'yes');
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /^ {10}log-analyst started on scripted: /m);
  assert.deepEqual(analystResponses(run.out), [1, 2, 3]);
  assert.match(
    run.out,
    /step 3 {4}model call failed: Rate limited \(429\)\. Restarting with backoff\./,
  );
  assert.match(run.out, /^step 4 {4}page_oncall waits for a person's approval$/m);
  assert.match(run.out, /^Approve page_oncall to payments\? \[y\/n\] y \(--approve yes\)$/m);
  assert.match(run.out, /^step 4 {4}page_oncall approved by operator$/m);
  assert.match(run.out, /reported: completed$/m);
  assert.equal(pages(run.out), 1);
  baseline = finalText(run.out);
  baselineLog = narration(run.out);
  assert.ok(baseline !== undefined, run.out);
});

check('a denied page is never sent, and the model is told and finishes without it', () => {
  const run = example('--reset', '--approve', 'no');
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /^step 4 {4}page_oncall denied by operator$/m);
  assert.match(
    run.out,
    /^step 4 {4}page_oncall error: A person denied this call\. operator: --approve no$/m,
  );
  assert.equal(pages(run.out), 0);
  assert.match(run.out, /reported: completed$/m);
  assert.match(finalText(run.out) ?? '', /I didn't page payments, because the page was denied/);
});

check(
  '--crash-while-waiting exits with 137, and a second run asks again with no new model call',
  () => {
    const crashed = example('--reset', '--crash-while-waiting', '--approve', 'yes');
    assert.equal(crashed.status, CRASHED, crashed.out);
    assert.equal(
      narration(crashed.out).at(-1),
      "step 4    page_oncall waits for a person's approval",
    );
    assert.equal(pages(crashed.out), 0);

    const resumed = example('--approve', 'yes');
    assert.equal(resumed.status, 0, resumed.out);
    assert.match(
      resumed.out,
      /^resuming incident-4211 from its journal: 10 events, 4 steps answered, waiting on tools$/m,
    );
    assert.match(
      resumed.out,
      /^still waiting: page_oncall \{"team":"payments",.*asked at event 10$/m,
    );
    // The only model call is step 5's, after the decision: steps 1 to 4 aren't asked again.
    assert.deepEqual(rootResponses(resumed.out), [5]);
    assert.deepEqual(analystResponses(resumed.out), []);
    assert.equal(pages(resumed.out), 1);
    // Between them, the two processes journal exactly what one uninterrupted process did.
    assert.deepEqual([...narration(crashed.out), ...narration(resumed.out)], baselineLog);
    assert.equal(finalText(resumed.out), baseline);
  },
);

check('--crash-after 3 crashes inside the analyst, and it resumes from its journal', () => {
  const crashed = example('--reset', '--crash-after', '3', '--approve', 'yes');
  assert.equal(crashed.status, CRASHED, crashed.out);
  assert.deepEqual(analystResponses(crashed.out), [1, 2]);
  assert.doesNotMatch(crashed.out, /finished:/);

  const resumed = example('--approve', 'yes');
  assert.equal(resumed.status, 0, resumed.out);
  assert.match(
    resumed.out,
    new RegExp(`^ {10}${ANALYST} resumes from its journal, at event 5$`, 'm'),
  );
  // The analyst isn't retried: it carries on at step 3, and starts nothing again.
  assert.deepEqual(analystResponses(resumed.out), [3]);
  assert.doesNotMatch(resumed.out, /log-analyst started/);
  assert.deepEqual([...narration(crashed.out), ...narration(resumed.out)], baselineLog);
  assert.equal(finalText(resumed.out), baseline);
});

check('a crash during page_oncall is reported to the model, and the page is not sent twice', () => {
  const crashed = example('--reset', '--crash-during', 'page_oncall', '--approve', 'yes');
  assert.equal(crashed.status, CRASHED, crashed.out);
  assert.equal(pages(crashed.out), 1);

  const resumed = example('--approve', 'yes');
  assert.equal(resumed.status, 0, resumed.out);
  assert.equal(pages(resumed.out), 0);
  assert.match(resumed.out, /^step 4 {4}page_oncall INTERRUPTED: /m);
  assert.match(resumed.out, /reported: completed$/m);
  assert.match(finalText(resumed.out) ?? '', /didn't send it again/);
});

check('--show prints the tree from its journals, the analyst under step 2', () => {
  const show = example('--show', 'incident-4211');
  assert.equal(show.status, 0, show.out);
  assert.match(show.out, /^incident-4211: 14 events$/m);
  assert.match(show.out, new RegExp(`^ {4}${ANALYST}: 7 events$`, 'm'));
  assert.match(show.out, /^ {4}#1 started by log-analyst on scripted: /m);
  for (let step = 1; step <= 5; step++) {
    assert.match(show.out, new RegExp(`^step ${String(step)}$`, 'm'));
  }
  // The analyst's journal is printed inside step 2, before the delegation's result.
  const lines = show.out.split('\n');
  const step2 = lines.indexOf('step 2');
  const analyst = lines.indexOf(`    ${ANALYST}: 7 events`);
  const step3 = lines.indexOf('step 3');
  assert.ok(step2 < analyst && analyst < step3, show.out);
  assert.match(show.out, /^ {4}finished: completed after 3 steps/m);
  assert.match(show.out, /#6 attempt failed: Rate limited \(429\)/);
  assert.match(show.out, /^ {4}#10 asked for approval; #11 approved by operator$/m);
  assert.match(show.out, /#12 INTERRUPTED: /);
  assert.match(show.out, /^finished: completed after 5 steps/m);
  // --show is read-only: nothing ran, so nothing was paged.
  assert.equal(pages(show.out), 0);
});

check('a finished run reports again, and calls nothing', () => {
  const again = example('--approve', 'yes');
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /has already finished/);
  assert.deepEqual(narration(again.out), []);
  assert.match(again.out, /reported: completed$/m);
});

check(
  '--cancel-after 2 cancels while the analyst works, and both journals end in cancelled',
  () => {
    const run = example('--reset', '--cancel-after', '2', '--approve', 'yes');
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /^!! cancelling incident-4211 after 2 steps$/m);
    assert.match(run.out, /reported: cancelled$/m);
    assert.equal(pages(run.out), 0);

    const show = example('--show', 'incident-4211');
    assert.equal(show.status, 0, show.out);
    assert.match(show.out, new RegExp(`^ {4}${ANALYST}: `, 'm'));
    assert.match(show.out, /^ {4}finished: cancelled after \d+ steps/m);
    assert.match(show.out, /^finished: cancelled after 2 steps/m);
  },
);

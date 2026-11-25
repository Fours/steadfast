// Runs examples/incident-triage on the scripted model, crash and resume included, and checks that
// each path ends as it should. CI runs it after the build: `npm run example:check`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../examples/incident-triage/main.ts', import.meta.url));
const CRASHED = 137;

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

/** The text the run finished with, from the narration. */
function finalText(out: string): string | undefined {
  const lines = out.split('\n');
  const at = lines.indexOf('finished: completed');
  return at === -1 ? undefined : lines[at + 1]?.trim();
}

/** The steps the narration shows, in order, from lines like `step 4    model ...`. */
function stepsShown(out: string): number[] {
  return [...out.matchAll(/^step (\d+) /gm)].map((m) => Number(m[1]));
}

/** The narration's lines for each event: what was journaled, in order. */
function narration(out: string): string[] {
  return out.split('\n').filter((line) => /^(step \d+ |finished: )/.test(line));
}

function check(name: string, body: () => void): void {
  body();
  console.log(`ok - ${name}`);
}

let baseline: string | undefined;
let baselineLog: string[] = [];

check('an uninterrupted run completes, after a rate-limited model call', () => {
  const run = example('--reset');
  assert.equal(run.status, 0, run.out);
  assert.match(
    run.out,
    /step 2 {4}model call failed: Rate limited \(429\)\. Restarting with backoff\./,
  );
  assert.match(run.out, /reported: completed$/m);
  assert.equal(run.out.match(/>> PAGE/g)?.length, 1);
  baseline = finalText(run.out);
  baselineLog = narration(run.out);
  assert.ok(baseline !== undefined, run.out);
});

check('--crash-after 3 exits with 137, and the same command resumes at step 4', () => {
  const crashed = example('--reset', '--crash-after', '3');
  assert.equal(crashed.status, CRASHED, crashed.out);
  assert.equal(Math.max(...stepsShown(crashed.out)), 3);
  assert.doesNotMatch(crashed.out, /finished:/);

  const resumed = example();
  assert.equal(resumed.status, 0, resumed.out);
  assert.match(
    resumed.out,
    /^resuming incident-4211 from its journal: 9 events, 3 steps answered/m,
  );
  // Nothing before step 4 runs again, and between them the two processes journal exactly what
  // one uninterrupted process did.
  assert.equal(Math.min(...stepsShown(resumed.out)), 4);
  assert.deepEqual([...narration(crashed.out), ...narration(resumed.out)], baselineLog);
  assert.equal(finalText(resumed.out), baseline);
});

check('a crash during page_oncall is reported to the model, and the page is not sent twice', () => {
  const crashed = example('--reset', '--crash-during', 'page_oncall');
  assert.equal(crashed.status, CRASHED, crashed.out);
  assert.equal(crashed.out.match(/>> PAGE/g)?.length, 1);

  const resumed = example();
  assert.equal(resumed.status, 0, resumed.out);
  assert.doesNotMatch(resumed.out, />> PAGE/);
  assert.match(resumed.out, /^step 4 {4}page_oncall INTERRUPTED: /m);
  assert.match(resumed.out, /reported: completed$/m);
  assert.match(finalText(resumed.out) ?? '', /didn't send it again/);
});

check('--show prints the run from its journal, step by step', () => {
  const show = example('--show', 'incident-4211');
  assert.equal(show.status, 0, show.out);
  assert.match(show.out, /^incident-4211: 13 events$/m);
  for (let step = 1; step <= 5; step++)
    assert.match(show.out, new RegExp(`^step ${String(step)}$`, 'm'));
  assert.match(show.out, /#5 attempt failed: Rate limited \(429\)/);
  assert.match(show.out, /#11 INTERRUPTED: /);
  assert.match(show.out, /^finished: completed after 5 steps/m);
  // --show is read-only: nothing ran, so nothing was paged.
  assert.doesNotMatch(show.out, />> PAGE/);
});

check('a finished run reports again, and calls nothing', () => {
  const again = example();
  assert.equal(again.status, 0, again.out);
  assert.match(again.out, /has already finished/);
  assert.deepEqual(stepsShown(again.out), []);
  assert.match(again.out, /reported: completed$/m);
});

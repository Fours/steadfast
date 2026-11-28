// An agent triages a fake checkout outage, on real time and SQLite, and hands log reading to a
// log-analyst sub-agent. Paging needs a person's approval. `npm run example` builds the package
// and runs this against dist/.
//
//   npm run example                              run, or resume, incident-4211
//   npm run example -- --reset                   forget every run and start again
//   npm run example -- --approve yes|no          answer the approval without asking
//   npm run example -- --crash-while-waiting     die with exit code 137 while the approval waits
//   npm run example -- --crash-after 3           die once 3 steps of the tree are journaled
//   npm run example -- --crash-during page_oncall   die after the page goes out, before it's journaled
//   npm run example -- --cancel-after 2          cancel the run once 2 steps of the tree are journaled
//   npm run example -- --show incident-4211      print the tree from its journals, with no model calls
//   npm run example -- --model anthropic         run on Claude (needs ANTHROPIC_API_KEY)
//   npm run example -- --model openai            run on OpenAI (needs OPENAI_API_KEY and OPENAI_MODEL)
//
// Run it again after a crash and it resumes from the journals: the same command starts a run and
// recovers one. Steps are counted across the tree in the order they finish, so `--cancel-after 2`
// lands while the log analyst is working, and `--crash-after 3` crashes inside it.

import { mkdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createActorSystem, realScheduler, silentLogger } from '@kylewillett/troupe';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import {
  agent,
  delegate,
  readRun,
  startRun,
  type Agent,
  type Model,
  type RunHandle,
  type TimelineToolCall,
} from '@kylewillett/steadfast';
import { scriptedModel } from '@kylewillett/steadfast/testkit';
import { narrator, printTree, waitingApprovals } from './narrate.ts';
import { scriptedModels } from './script.ts';
import { exampleTools } from './tools.ts';

const RUN_ID = 'incident-4211';
const INPUT = 'Checkout is returning 502s. Find the cause, and page the team that owns it.';
const TRIAGE_SYSTEM =
  'You triage production incidents. Ask the log analyst to read logs for you, check metrics ' +
  "yourself, page the owning team's on-call once you're sure, then say what to do next. Never " +
  'page a team twice for one incident: if a page may not have gone out, say so instead of paging ' +
  'again. If a person denies a page, say so, and suggest another way to reach the team.';
const ANALYST_SYSTEM = 'You read service logs and say what they show. Quote the lines that matter.';
/** What a crashed process exits with: what a shell reports for one killed by SIGKILL. */
const CRASHED = 137;
/** Who decides here, for the journal. */
const OPERATOR = 'operator';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'scripted' },
    reset: { type: 'boolean', default: false },
    approve: { type: 'string' },
    'crash-while-waiting': { type: 'boolean', default: false },
    'crash-after': { type: 'string' },
    'crash-during': { type: 'string' },
    'cancel-after': { type: 'string' },
    show: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function stepCount(flag: 'crash-after' | 'cancel-after'): number | undefined {
  const value = values[flag];
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(Number.isInteger(n) && n > 0)) fail(`--${flag} takes a number of steps, from 1`);
  return n;
}
const crashAfter = stepCount('crash-after');
const cancelAfter = stepCount('cancel-after');
if (values['crash-during'] !== undefined && values['crash-during'] !== 'page_oncall') {
  fail('--crash-during takes page_oncall, the one tool that is not safe to run twice');
}
if (!['scripted', 'anthropic', 'openai'].includes(values.model)) {
  fail('--model takes scripted, anthropic or openai');
}
if (values.approve !== undefined && values.approve !== 'yes' && values.approve !== 'no') {
  fail('--approve takes yes or no');
}
if (values.show === undefined && values.approve === undefined && !process.stdin.isTTY) {
  fail('--approve yes|no is needed when stdin is not a terminal, since nobody can be asked');
}

function crash(why: string): never {
  narration.say(
    `!! crash: ${why}. Exiting with ${String(CRASHED)}. Run the same command to resume.`,
  );
  process.exit(CRASHED);
}

const dir = fileURLToPath(new URL('../../.steadfast/', import.meta.url));
const path = `${dir}incident-triage.db`;
if (values.reset) {
  // WAL mode keeps two files beside the database.
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
}
mkdirSync(dir, { recursive: true });
const persistence = sqlitePersistence({ path });

const tools = exampleTools({
  afterPage: () => {
    if (values['crash-during'] === 'page_oncall') crash('page_oncall sent its page');
  },
});

/** The two agents, on their models. Everything else is the same for every model. */
function agents(models: { triage: Model; analyst: Model }): { triage: Agent; analyst: Agent } {
  const analyst = agent({
    name: 'log-analyst',
    model: models.analyst,
    system: ANALYST_SYSTEM,
    tools: [tools.readLog],
    budget: { maxSteps: 10 },
    persistence,
  });
  const triage = agent({
    name: 'triage',
    model: models.triage,
    system: TRIAGE_SYSTEM,
    tools: [
      tools.queryMetrics,
      tools.pageOncall,
      delegate(analyst, {
        name: 'ask_log_analyst',
        description:
          'Give the log analyst a task, such as "find errors in checkout since 14:00". It reads ' +
          'service logs and says what they show.',
      }),
    ],
    budget: { maxSteps: 20, maxTokens: 200_000, deadlineMs: 15 * 60_000 },
    persistence,
  });
  return { triage, analyst };
}

// Reading needs the agents' journals and names, never their models: these throw if called.
const readers = agents({ triage: scriptedModel([]), analyst: scriptedModel([]) });

if (values.show !== undefined) {
  await printTree(readers.triage, values.show);
  persistence.close();
  process.exit(0);
}

// Where the journals say the runs are. The analyst's run id comes from the root's journal, the
// way the run derives it. A resumed run's scripted model starts where it left off.
const before = await readRun(readers.triage, RUN_ID);
const analystRun = before.steps.flatMap((s) => s.tools).find((t) => t.subRun)?.subRun?.runId;
const analystBefore =
  analystRun === undefined ? undefined : await readRun(readers.analyst, analystRun);

const narration = narrator({
  onStepFinished: (count) => {
    if (count === crashAfter) crash(`${String(count)} steps are journaled`);
    if (count === cancelAfter) {
      narration.say(`!! cancelling ${RUN_ID} after ${String(count)} steps`);
      handle.cancel(`Asked to stop with --cancel-after ${String(count)}`);
    }
  },
});
narration.learn(RUN_ID, before);
if (analystRun !== undefined && analystBefore !== undefined) {
  narration.learn(analystRun, analystBefore);
}

async function claude(): Promise<Model> {
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    fail('--model anthropic needs ANTHROPIC_API_KEY');
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { anthropicModel } = await import('@kylewillett/steadfast/anthropic');
  return anthropicModel({ client: new Anthropic() });
}

async function openai(): Promise<Model> {
  const model = process.env.OPENAI_MODEL;
  if (process.env.OPENAI_API_KEY === undefined || model === undefined) {
    fail('--model openai needs OPENAI_API_KEY, and OPENAI_MODEL to name the model');
  }
  const { default: OpenAI } = await import('openai');
  const { openaiModel } = await import('@kylewillett/steadfast/openai');
  return openaiModel({ client: new OpenAI(), model });
}

async function models(): Promise<{ triage: Model; analyst: Model }> {
  if (values.model === 'anthropic') {
    const model = await claude();
    return { triage: model, analyst: model };
  }
  if (values.model === 'openai') {
    const model = await openai();
    return { triage: model, analyst: model };
  }
  return scriptedModels({ triage: before.state.step, analyst: analystBefore?.state.step ?? 0 });
}
const { triage, analyst } = agents(await models());

if (before.state.phase === 'finished') {
  console.log(`${RUN_ID} has already finished. It reports again. --reset starts a new run.`);
} else if (before.state.phase === 'running') {
  console.log(
    `resuming ${RUN_ID} from its journal: ${String(before.events.length)} events, ` +
      `${String(before.state.step)} steps answered, waiting on ${before.state.pending.kind}`,
  );
} else {
  console.log(`${RUN_ID}: a new run on ${triage.model.name}`);
}

/** What the agent of a run in this tree is, by its id. */
function agentOf(runId: string): Agent {
  return runId.includes('/') ? analyst : triage;
}

const prompt = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;

/** Asks for a decision on `tool`'s call, or takes it from `--approve`. */
async function ask(tool: string, input: unknown): Promise<boolean> {
  const team =
    typeof input === 'object' && input !== null && 'team' in input
      ? ` to ${String(input.team)}`
      : '';
  const question = `Approve ${tool}${team}? [y/n] `;
  if (values.approve !== undefined) {
    narration.say(
      `${question}${values.approve === 'yes' ? 'y' : 'n'} (--approve ${values.approve})`,
    );
    return values.approve === 'yes';
  }
  for (;;) {
    narration.say('');
    const answer = (await prompt?.question(question))?.trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
  }
}

/** Decides one waiting call, from whichever run it's in. */
async function decide(runId: string, callId: string, tool: string, input: unknown): Promise<void> {
  const approved = await ask(tool, input);
  const note =
    values.approve === undefined ? 'Decided at the terminal.' : `--approve ${values.approve}`;
  const reply = await handle.decide({ runId, callId, approved, by: OPERATOR, note });
  if (!reply.ok) narration.say(`!! the decision wasn't taken: ${reply.reason}`);
}

/** On a run's recovery, asks again about any call its journal says is still waiting. */
async function resumed(runId: string, seq: number): Promise<void> {
  if (seq === 0) return;
  const waiting: TimelineToolCall[] = waitingApprovals(
    await readRun(agentOf(runId), runId, { upTo: seq }),
  );
  for (const call of waiting) {
    narration.say(
      `still waiting: ${call.name} ${JSON.stringify(call.input)}, asked at event ` +
        String(call.approval?.requestedSeq),
    );
    await decide(runId, call.callId, call.name, call.input);
  }
}

// Troupe would log each step's restart. The journal already says it, so the logger stays quiet.
const system = createActorSystem({
  name: 'triage',
  scheduler: realScheduler(),
  logger: silentLogger,
});
const handle: RunHandle = startRun(system, triage, RUN_ID, {
  input: INPUT,
  onProgress: (progress) => {
    narration.show(progress);
    if (progress.type === 'resumed') void resumed(progress.runId, progress.seq);
    if (progress.type === 'journaled' && progress.event.type === 'approvalRequested') {
      const { event } = progress;
      if (values['crash-while-waiting']) crash(`${event.tool} is waiting for approval`);
      void decide(event.runId, event.callId, event.tool, event.input);
    }
  },
});

const report = await handle.done;
prompt?.close();
await system.terminate();
persistence.close();
// The narration has shown how the run finished, unless it finished in an earlier process.
if (before.state.phase === 'finished') console.log(report.text);
console.log(`reported: ${report.outcome}`);

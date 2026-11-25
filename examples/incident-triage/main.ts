// An agent triages a fake checkout outage, on real time and SQLite. `npm run example` builds the
// package and runs this against dist/.
//
//   npm run example                              run, or resume, incident-4211
//   npm run example -- --reset                   forget every run and start again
//   npm run example -- --reset --crash-after 3   die with exit code 137 once step 3 is journaled
//   npm run example -- --crash-during page_oncall   die after the page goes out, before it's journaled
//   npm run example -- --show incident-4211      print the run from its journal, with no model calls
//   npm run example -- --model anthropic         run on Claude (needs ANTHROPIC_API_KEY)
//
// Run it again after a crash and it resumes from the journal: the same command starts a run and
// recovers one.

import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { actor, createActorSystem, realScheduler, silentLogger } from '@kylewillett/troupe';
import type { Persistence } from '@kylewillett/troupe/persistence';
import { sqlitePersistence } from '@kylewillett/troupe/persistence/sqlite';
import { agent, readRun, type Model, type RunReport } from '@kylewillett/steadfast';
import { scriptedModel } from '@kylewillett/steadfast/testkit';
import { narrated, printTimeline } from './narrate.ts';
import { scriptedTriage } from './script.ts';
import { triageTools } from './tools.ts';

const RUN_ID = 'incident-4211';
const INPUT = 'Checkout is returning 502s. Find the cause, and page the team that owns it.';
const SYSTEM =
  'You triage production incidents. Read logs and metrics to find the cause, page the owning ' +
  "team's on-call once you're sure, then say what to do next. Never page a team twice for one " +
  'incident: if a page may not have gone out, say so instead of paging again.';
/** What a crashed process exits with: what a shell reports for one killed by SIGKILL. */
const CRASHED = 137;

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'scripted' },
    reset: { type: 'boolean', default: false },
    'crash-after': { type: 'string' },
    'crash-during': { type: 'string' },
    show: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const crashAfter = values['crash-after'] === undefined ? undefined : Number(values['crash-after']);
if (crashAfter !== undefined && !(Number.isInteger(crashAfter) && crashAfter > 0)) {
  fail('--crash-after takes a step number, from 1');
}
if (values['crash-during'] !== undefined && values['crash-during'] !== 'page_oncall') {
  fail('--crash-during takes page_oncall, the one tool that is not safe to run twice');
}
if (values.model !== 'scripted' && values.model !== 'anthropic') {
  fail('--model takes scripted or anthropic');
}

function crash(why: string): never {
  console.log(`!! crash: ${why}. Exiting with ${String(CRASHED)}. Run the same command to resume.`);
  process.exit(CRASHED);
}

const dir = fileURLToPath(new URL('../../.steadfast/', import.meta.url));
const path = `${dir}incident-triage.db`;
if (values.reset) {
  // WAL mode keeps two files beside the database.
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
}
mkdirSync(dir, { recursive: true });
const sqlite = sqlitePersistence({ path });

const tools = triageTools({
  afterPage: () => {
    if (values['crash-during'] === 'page_oncall') crash('page_oncall sent its page');
  },
});

/** The agent, on `model` and `persistence`. Everything else is the same for every model. */
function triage(model: Model, persistence: Persistence = sqlite) {
  return agent({
    name: 'triage',
    model,
    system: SYSTEM,
    tools,
    budget: { maxSteps: 20, maxTokens: 200_000, deadlineMs: 15 * 60_000 },
    persistence,
  });
}

// Reading needs the agent's journal and name, never its model: this one throws if it's called.
const reader = triage(scriptedModel([]));

if (values.show !== undefined) {
  printTimeline(values.show, await readRun(reader, values.show));
  sqlite.close();
  process.exit(0);
}

// Where the journal says the run is. A resumed run's scripted model starts where it left off.
const before = await readRun(reader, RUN_ID);
const persistence = narrated(sqlite, {
  calls: before.steps.flatMap((s) => s.tools.map((t) => [t.callId, t.name] as const)),
  onStepJournaled: (step) => {
    if (step === crashAfter) crash(`step ${String(step)} is journaled`);
  },
});

async function claude(): Promise<Model> {
  if (process.env.ANTHROPIC_API_KEY === undefined)
    fail('--model anthropic needs ANTHROPIC_API_KEY');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { anthropicModel } = await import('@kylewillett/steadfast/anthropic');
  return anthropicModel({ client: new Anthropic() });
}
const model = values.model === 'anthropic' ? await claude() : scriptedTriage(before.state.step);

if (before.state.phase === 'finished') {
  console.log(`${RUN_ID} has already finished. It reports again. --reset starts a new run.`);
} else if (before.state.phase === 'running') {
  console.log(
    `resuming ${RUN_ID} from its journal: ${String(before.events.length)} events, ` +
      `${String(before.state.step)} steps answered, waiting on ${before.state.pending.kind}`,
  );
} else {
  console.log(`${RUN_ID}: a new run on ${model.name}`);
}

// Troupe would log each step's restart. The journal already says it, so the logger stays quiet.
const system = createActorSystem({
  name: 'triage',
  scheduler: realScheduler(),
  logger: silentLogger,
});
const report = await new Promise<RunReport>((resolve) => {
  // Hears the run's report. A run reports once per incarnation, so the first one is the answer.
  const desk = system.spawn(
    actor<RunReport, null>({
      initial: () => null,
      receive: (state, msg) => {
        resolve(msg);
        return state;
      },
    }),
    'desk',
  );
  system.spawn(triage(model, persistence).run(RUN_ID, { input: INPUT, reportTo: desk }), RUN_ID);
});

await system.terminate();
sqlite.close();
// The narration has shown how the run finished, unless it finished in an earlier process.
if (before.state.phase === 'finished') console.log(report.text);
console.log(`reported: ${report.outcome}`);

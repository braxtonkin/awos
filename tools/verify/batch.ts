import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { withBrowser } from './browser.ts';
import { checksOf, fail, info, pass, render, type Line, type Scenario } from './check.ts';
import { buildDashboard, groupsOf, runGroups, worldsStarted, type Lane } from './dashboard.ts';
import { screens, type Screen } from './screens/screens.ts';

const step = z.tuple([z.string().min(1)], z.string()).readonly();

export const batch = z.strictObject({ scenarios: z.array(step).readonly(), engine: z.array(step).readonly() }).readonly();

export type Batch = z.infer<typeof batch>;

export type Registered = { readonly screens: readonly Screen[]; readonly lanes: readonly Lane[]; readonly batches: readonly Batch[] };

export type RunNamed = (name: string, args: readonly string[]) => Promise<readonly Line[]>;

const folder = join(fileURLToPath(new URL('../../', import.meta.url)), '.shots', 'batch');

const secondsSince = (since: number): number => (performance.now() - since) / 1000;

async function judged(label: string, lines: readonly Line[], took: number): Promise<Line> {
  const log = join(folder, 'logs', `${label.replaceAll(/[^a-z0-9-]+/gi, '-')}.txt`);
  await mkdir(join(folder, 'logs'), { recursive: true });
  await writeFile(log, render(lines).text);
  const time = `${took.toFixed(1)} s`;
  const checks = checksOf(lines);
  const failed = checks.filter(check => !check.passed);
  if (checks.length === 0) return fail(label, `no check ran, ${time}, ${log}`);
  if (failed.length === 0) return pass(label, `${String(checks.length)} checks, ${time}`);
  return fail(label, `${String(failed.length)} of ${String(checks.length)} failed, ${time}: ${failed.slice(0, 3).map(check => check.name).join('; ')}; ${log}`);
}

const caught = (name: string) => (error: unknown): readonly Line[] => [fail(`${name} runs to completion`, error instanceof Error ? error.message : String(error))];

export const dashboardBatch = (registered: Registered, runNamed: RunNamed): Scenario => ({
  name: 'dashboard-batch',
  summary:
    "runs every registered dashboard step once: each group's screens, each feature's batch scenarios with their plants, every lane in as few local worlds as the lanes' needs allow, and the engine checks; prints one line per step, each world's ready time, and the wall time, saves screenshots under .shots/batch/, and takes --without-real to skip lanes that run real Codex",
  run: async args => {
    const { values } = parseArgs({ args: [...args], options: { 'without-real': { type: 'boolean', default: false } }, strict: true });
    const began = performance.now();
    const worldsBefore = worldsStarted().length;
    const echo = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    const lines: Line[] = [];
    const named = async (kind: string, steps: readonly (readonly string[])[]): Promise<void> => {
      for (const [name = '', ...rest] of new Map(steps.map(each => [each.join(' '), each])).values()) {
        const since = performance.now();
        lines.push(await judged(`${kind} ${[name, ...rest].join(' ')}`, await runNamed(name, rest), secondsSince(since)));
      }
    };
    await buildDashboard(false, echo);
    const screensSince = performance.now();
    const shot = await screens(registered.screens, join(folder, 'screens')).run(['all']).catch(caught('screens'));
    lines.push(await judged('screens all', shot, secondsSince(screensSince)));
    await named('scenario', registered.batches.flatMap(each => each.scenarios));
    const skipped = values['without-real'] ? registered.lanes.filter(lane => lane.agent === 'real') : [];
    const lanes = registered.lanes.filter(lane => !skipped.includes(lane));
    const groups = groupsOf(lanes, undefined);
    const ran = await withBrowser(browser => runGroups(groups, browser, folder, echo));
    for (const each of ran) lines.push(await judged(`lane ${each.lane.unit} ${each.lane.id}`, each.lines, each.seconds));
    for (const lane of skipped) lines.push(info(`lane ${lane.unit} ${lane.id}`, 'n/a', 'skipped: it runs real Codex, and --without-real was given'));
    await named('engine', registered.batches.flatMap(each => each.engine));
    const worlds = worldsStarted().slice(worldsBefore);
    lines.push(
      ...worlds.map((world, index) => info(`world ${String(index + 1)} ready`, 'passed', `${world.readySeconds.toFixed(1)} s, seeds ${world.seeds.join(' ')}`)),
      info('worlds', 'passed', `${String(worlds.length)} started, ${String(groups.length)} of them for ${String(lanes.length)} lanes, ${worlds.reduce((total, world) => total + world.readySeconds, 0).toFixed(1)} s to ready in all`),
      info('wall time', 'passed', `${secondsSince(began).toFixed(1)} s`),
    );
    return lines;
  },
});

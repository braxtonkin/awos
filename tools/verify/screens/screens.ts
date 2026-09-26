import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import type { Browser } from 'playwright-core';
import { z } from 'zod';
import { open, record, run, shoot, withBrowser, type Script, type Served, type Step, type Theme } from '../browser.ts';
import { fail, info, pass, type Line, type Scenario } from '../check.ts';
import { buildDashboard, withWorld } from '../dashboard.ts';
import { isClutter, judge, measured, readLimits, verdict, type Captured, type GateId, type Judged, type Limits, type Measured } from './gates.ts';
import { measure, type MeasureConfig } from './measure.ts';
import { decode, differing } from './png.ts';
import { plant, plantIds, plantedFixture } from './plants.ts';

export const groups = ['chrome', 'overview', 'task', 'agent', 'routines', 'settings'] as const;

export type Group = (typeof groups)[number];

const step = z.union([
  z.strictObject({ click: z.string().min(1) }).readonly(),
  z.strictObject({ fill: z.string().min(1), text: z.string() }).readonly(),
  z.strictObject({ press: z.string().min(1) }).readonly(),
  z.strictObject({ waitFor: z.string().min(1) }).readonly(),
]) satisfies z.ZodType<Step>;

export const screen = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    group: z.enum(groups),
    path: z.string().startsWith('/'),
    seed: z.string().min(1),
    steps: z.array(step).readonly(),
    height: z.number().int().positive(),
    names: z.array(z.string().min(1)).readonly().optional(),
    alone: z.literal(true).optional(),
  })
  .readonly();

export type Screen = z.infer<typeof screen>;

const root = fileURLToPath(new URL('../../../', import.meta.url));

export const shotsOf = (scenario: string): string => join(root, '.shots', scenario);

type Fixture = { readonly name: string; readonly group: Group | 'control'; readonly height: number; readonly names: readonly string[] };

const people = ['Braxton Kinney', 'Sam Okafor', 'Priya Raman', 'Jordan Lee'];

export const actingPerson = 'Braxton Kinney';

export const actAs = (name: string): readonly Step[] => [
  { click: 'summary[aria-label="Acting as"]' },
  { click: `role=menuitemradio[name="${name}"]` },
  { waitFor: `summary[aria-label="Acting as"]:has-text("${name}")` },
];

const control: Fixture = { name: 'task-a-live', group: 'control', height: 1000, names: people };

export const fixtures: readonly Fixture[] = [control, { name: plantedFixture, group: 'task', height: 900, names: people }];

export type Target = { readonly name: string; readonly url: string; readonly served?: Served; readonly steps: readonly Step[]; readonly height: number; readonly names: readonly string[] };

const fixtureOrigin = 'http://fixtures.test';

const fixtureFolder = new URL('fixtures/', import.meta.url);

export const fixtureTarget = (fixture: Fixture, planted: readonly GateId[] = []): Target => ({
  name: fixture.name,
  url: `${fixtureOrigin}/${fixture.name}.html`,
  served: {
    origin: fixtureOrigin,
    read: async path => {
      const file = await readFile(new URL(path, fixtureFolder)).catch(() => undefined);
      return file === undefined || planted.length === 0 || path !== `${fixture.name}.html` ? file : Buffer.from(plant(file.toString('utf8'), planted));
    },
  },
  steps: [],
  height: fixture.height,
  names: fixture.names,
});

export type Capture = {
  readonly name: string;
  readonly captured: Captured;
  readonly errors: readonly string[];
  readonly seconds: number;
  readonly shots: Readonly<Record<Theme, string>>;
  readonly size: { readonly w: number; readonly h: number };
};

type Look = { readonly measured: Measured; readonly errors: readonly string[]; readonly path: string };

export async function capture(browser: Browser, target: Target, limits: Limits, folder: string, label: string = target.name): Promise<Capture> {
  await mkdir(folder, { recursive: true });
  const started = performance.now();
  const cfg: MeasureConfig = { fold: limits.fold, ...limits.rules, properNouns: [...limits.rules.properNouns, ...target.names] };
  const size = { w: limits.width, h: Math.max(target.height, limits.fold) };
  const look = (theme: Theme): Promise<Look> =>
    open(browser, { url: target.url, width: size.w, height: size.h, theme, steps: target.steps, ...(target.served === undefined ? {} : { served: target.served }) }, async ({ page, errors }) => {
      const path = join(folder, `${label}.${theme}.png`);
      await shoot(page, path);
      return { measured: measured.parse(await run(page, measure, cfg)), errors: [...errors], path };
    });
  const light = await look('light');
  const dark = await look('dark');
  return {
    name: target.name,
    captured: { light: light.measured, dark: dark.measured },
    errors: [...light.errors, ...dark.errors],
    seconds: (performance.now() - started) / 1000,
    shots: { light: light.path, dark: dark.path },
    size,
  };
}

export const renders = (capture: Capture): Line => {
  const name = `${capture.name} renders at ${String(capture.size.w)} by ${String(capture.size.h)} in both themes`;
  const viewports = [capture.captured.light.viewport, capture.captured.dark.viewport];
  const sized = viewports.every(viewport => viewport.w === capture.size.w && viewport.h === capture.size.h);
  if (capture.errors.length > 0) return fail(name, capture.errors.join('; '));
  return sized ? pass(name, `${capture.shots.light}, ${capture.shots.dark}`) : fail(name, `the page measured ${viewports.map(viewport => `${String(viewport.w)}x${String(viewport.h)}`).join(' and ')}`);
};

export const gateLines = (capture: Capture, limits: Limits): readonly Line[] => judge(capture.captured, limits).map(judged => (judged.passed ? pass : fail)(`${capture.name} ${judged.id}`, verdict(judged)));

function controlStillFails(capture: Capture, limits: Limits): readonly Line[] {
  const judged = judge(capture.captured, limits);
  const failing = judged.filter(result => isClutter(result) && !result.passed);
  return [
    ...judged.map(result => info(`control ${capture.name} ${result.id}`, result.passed ? 'passed' : 'failed', verdict(result))),
    failing.length > 0
      ? pass(`control ${capture.name} fails ${String(failing.length)} clutter gates`, failing.map(result => result.id).join(', '))
      : fail(`control ${capture.name} fails at least one clutter gate`, 'it passes every clutter gate, so the gates have drifted and this run is void'),
  ];
}

const roundFour = z.record(z.string(), z.record(z.string(), z.number()));

const tolerance: Partial<Record<GateId, number>> = { 'clutter.words': 2, 'clutter.boxes': 1 };

async function matchesRoundFour(capture: Capture, limits: Limits): Promise<readonly Line[]> {
  const expected = roundFour.parse(JSON.parse(await readFile(new URL('round-4.json', fixtureFolder), 'utf8')))[capture.name] ?? {};
  return judge(capture.captured, limits).map((judged: Judged) => {
    const want = expected[judged.id];
    const name = `${capture.name} ${judged.id} matches round 4`;
    if (want === undefined) return fail(name, 'round-4.json holds no value for it');
    const slack = tolerance[judged.id] ?? 0;
    return Math.abs(judged.value - want) <= slack ? pass(name, `${String(judged.value)}, round 4 ${String(want)}`) : fail(name, `${String(judged.value)}, round 4 ${String(want)}, allowed ${String(slack)}`);
  });
}

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const secondsPerScreen = 6;

const timing = (captures: readonly Capture[]): Line => {
  const seconds = median(captures.map(each => each.seconds));
  const name = `one screen takes at most ${String(secondsPerScreen)} s to capture and judge in both themes, at the median`;
  const detail = `median ${seconds.toFixed(2)} s over ${String(captures.length)} captures: ${captures.map(each => each.seconds.toFixed(2)).join(', ')}`;
  return (seconds <= secondsPerScreen ? pass : fail)(name, detail);
};

const identicalShare = 0.001;

async function repeatable(browser: Browser, target: Target, first: Capture, limits: Limits, folder: string, times: number): Promise<readonly [readonly Line[], readonly Capture[]]> {
  const again: Capture[] = [];
  for (let round = 2; round <= times; round += 1) again.push(await capture(browser, target, limits, folder, `${target.name}.repeat-${String(round)}`));
  const firstShot = decode(await readFile(first.shots.light));
  const lines = await Promise.all(
    again.map(async (next, index) => {
      const label = `capture ${String(index + 2)} of ${target.name}`;
      const same = JSON.stringify(next.captured) === JSON.stringify(first.captured);
      const share = differing(firstShot, decode(await readFile(next.shots.light)), 0);
      return [
        (same ? pass : fail)(`${label} measures the same as the first`, same ? 'every metric is identical' : 'the metrics differ'),
        (share < identicalShare ? pass : fail)(`${label} differs from the first in under 0.1% of pixels`, `${(share * 100).toFixed(4)}%`),
      ];
    }),
  );
  return [lines.flat(), again];
}

type VideoPage = { readonly document: { querySelector(selector: string): Video | null } };

type Video = { currentTime: number; readonly duration: number; addEventListener(type: string, listener: () => void, options: { readonly once: boolean }): void };

const seek: Script<VideoPage, number, Promise<number>> = (window, second) =>
  new Promise((resolve, reject) => {
    const video = window.document.querySelector('video');
    if (video === null) {
      reject(new Error('the frame page holds no video'));
      return;
    }
    const jump = (): void => {
      video.addEventListener('seeked', () => {
        resolve(video.duration);
      }, { once: true });
      video.currentTime = second;
    };
    if (Number.isNaN(video.duration)) video.addEventListener('loadedmetadata', jump, { once: true });
    else jump();
  });

const frameMatch = 0.9;

async function recorded(browser: Browser, target: Target, first: Capture, folder: string, seconds: number): Promise<readonly Line[]> {
  const size = first.size;
  const webm = join(folder, `${target.name}.webm`);
  await record(browser, { url: target.url, width: size.w, height: size.h, theme: 'light', steps: target.steps, ...(target.served === undefined ? {} : { served: target.served }) }, seconds, webm);
  const clip = await readFile(webm);
  const origin = 'http://video.test';
  const page = `<!doctype html><body style="margin:0;background:#000"><video src="clip.webm" muted style="display:block;width:${String(size.w)}px;height:${String(size.h)}px"></video></body>`;
  const framePath = join(folder, `${target.name}.frame.png`);
  const duration = await open(browser, { url: `${origin}/index.html`, width: size.w, height: size.h, theme: 'light', steps: [], served: { origin, read: path => Promise.resolve(path === 'clip.webm' ? clip : path === 'index.html' ? Buffer.from(page) : undefined) } }, async ({ page: frame }) => {
    const length = z.number().parse(await run(frame, seek, seconds / 2));
    await shoot(frame, framePath);
    return length;
  });
  const share = 1 - differing(decode(await readFile(first.shots.light)), decode(await readFile(framePath)), 48);
  return [
    (duration >= seconds - 1 ? pass : fail)(`the video of ${target.name} plays for ${String(seconds)} s`, `${webm} lasts ${duration.toFixed(1)} s`),
    (share >= frameMatch ? pass : fail)(`the frame at ${String(seconds / 2)} s holds the fixture`, `${framePath}, ${(share * 100).toFixed(1)}% of pixels match the screenshot`),
  ];
}

const gateArgs = (args: readonly string[]): { readonly planted: readonly GateId[]; readonly repeat: number; readonly video: number | undefined } => {
  const { values } = parseArgs({ args: [...args], options: { plant: { type: 'string', multiple: true }, repeat: { type: 'string' }, video: { type: 'string' } }, strict: true, allowPositionals: false });
  const planted = (values.plant ?? []).map(id => {
    const known = plantIds.find(each => each === id);
    if (known === undefined) throw new Error(`there is no plant for ${id}; the plants are ${plantIds.join(', ')}`);
    return known;
  });
  const repeat = z.coerce.number().int().min(1).parse(values.repeat ?? '3');
  const video = values.video === undefined ? undefined : z.coerce.number().positive().parse(values.video);
  return { planted, repeat, video };
};

export const screenGates: Scenario = {
  name: 'screen-gates',
  summary: 'captures the fixtures and judges every gate: the busy control must fail a clutter gate and the revised page must pass them all; takes --plant <gate> to plant a violation, --repeat <n>, and --video <seconds>',
  run: async args => {
    const { planted, repeat, video } = gateArgs(args);
    const limits = await readLimits();
    const folder = shotsOf('screen-gates');
    return withBrowser(async browser => {
      const lines: Line[] = [];
      const captures: Capture[] = [];
      for (const fixture of fixtures) {
        const target = fixtureTarget(fixture, fixture.name === plantedFixture ? planted : []);
        const taken = await capture(browser, target, limits, folder, planted.length > 0 && fixture.name === plantedFixture ? `${fixture.name}.planted` : fixture.name);
        captures.push(taken);
        lines.push(renders(taken));
        lines.push(...(fixture.group === 'control' ? controlStillFails(taken, limits) : gateLines(taken, limits)));
        if (planted.length > 0) continue;
        lines.push(...(await matchesRoundFour(taken, limits)));
        if (fixture.group === 'control') continue;
        const [same, again] = await repeatable(browser, target, taken, limits, folder, repeat);
        lines.push(...same);
        captures.push(...again);
        if (video !== undefined) lines.push(...(await recorded(browser, target, taken, folder, video)));
      }
      if (planted.length > 0) lines.push(info(`planted ${planted.join(', ')} in ${plantedFixture}`, 'n/a', 'the planted gates should fail'));
      lines.push(timing(captures));
      return lines;
    });
  },
};

export const screens = (declared: readonly Screen[], folder: string = shotsOf('screens')): Scenario => ({
  name: 'screens',
  summary: `captures every declared screen of a group, or all, at 1440 by 900 in both themes and judges each gate, beside the busy control; the groups are ${groups.join(', ')}`,
  run: async args => {
    const [group, ...rest] = args;
    const known = groups.find(each => each === group);
    if (rest.length > 0 || (group !== 'all' && known === undefined)) throw new Error(`screens takes one argument, all or a group: ${groups.join(', ')}`);
    const selected = declared.filter(each => group === 'all' || each.group === known);
    const limits = await readLimits();
    return withBrowser(async browser => {
      const taken = await capture(browser, fixtureTarget(control), limits, folder);
      const lines: Line[] = [renders(taken), ...controlStillFails(taken, limits)];
      if (selected.length === 0) return [...lines, info(`no feature declares a screen in ${group ?? 'all'}`, 'n/a', 'a feature adds screens by exporting them from its verify.ts')];
      for (const shot of (await captureDeclared(browser, selected, limits, folder)).captures) lines.push(renders(shot), ...gateLines(shot, limits));
      return lines;
    });
  },
});

export type Declared = { readonly captures: readonly Capture[]; readonly people: readonly string[] };

export async function captureDeclared(browser: Browser, selected: readonly Screen[], limits: Limits, folder: string): Promise<Declared> {
  const echo = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  await buildDashboard(false, echo);
  const taken = new Map<Screen, Capture>();
  const everyone = new Set<string>();
  for (const members of Map.groupBy(selected, each => (each.alone === true ? each.seed : '')).values()) {
    await withWorld([...new Set(members.map(each => each.seed))], echo, async world => {
      for (const each of members) {
        const key = world.keys.get(each.seed);
        if (key === undefined) throw new Error(`local-engine printed no key for the seed ${each.seed}, which ${each.name} needs`);
        const url = `${world.origin}${each.path.replace('{key}', encodeURIComponent(key))}`;
        taken.set(each, await capture(browser, { name: each.name, url, steps: [...actAs(actingPerson), ...each.steps], height: each.height, names: each.names ?? people }, limits, folder));
      }
      const seeded = await sql<{ name: string }>`select name from person where kind = 'person' order by name`.execute(world.owner);
      for (const row of seeded.rows) everyone.add(row.name);
    });
  }
  return { captures: selected.flatMap(each => taken.get(each) ?? []), people: [...everyone].toSorted() };
}

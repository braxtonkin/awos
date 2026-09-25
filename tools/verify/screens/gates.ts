import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const count = z.number().int().nonnegative();

const item = z.strictObject({ box: z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly(), what: z.string() }).readonly();

const found = z.strictObject({ count, items: z.array(item).readonly() }).readonly();

const checked = z.strictObject({ checked: count, count, items: z.array(item).readonly() }).readonly();

export const measured = z
  .strictObject({
    viewport: z.strictObject({ w: z.number(), h: z.number(), scrollY: z.number(), pageHeight: z.number() }).readonly(),
    topbar: z.boolean(),
    clutter: z.strictObject({ boxes: count, fontSizes: count, fontWeights: count, colors: count, controls: count, words: count }).readonly(),
    clutterDetail: z
      .strictObject({
        fontSizes: z.array(z.number()).readonly(),
        fontWeights: z.array(z.number()).readonly(),
        colors: z.array(z.string()).readonly(),
        boxes: z.array(item).readonly(),
        controls: z.array(item).readonly(),
      })
      .readonly(),
    primaryButtons: found,
    unlabelledState: found,
    greenOutsideLanded: found,
    titleCaseHeadings: found,
    longButtonLabels: found,
    internalTerms: found,
    spacingOffScale: found,
    typeOffScale: found,
    undeliveredMessages: checked,
    rawData: found,
    unansweredQuestions: checked,
    contrast: z.strictObject({ checked: count, min: z.number().nullable(), count, items: z.array(item).readonly() }).readonly(),
  })
  .readonly();

export type Measured = z.infer<typeof measured>;

export type Item = Measured['rawData']['items'][number];

export type Captured = { readonly light: Measured; readonly dark: Measured };

const clutterKeys = ['boxes', 'fontSizes', 'fontWeights', 'colors', 'controls', 'words'] as const;

type ClutterKey = (typeof clutterKeys)[number];

export type GateId =
  | `clutter.${ClutterKey}`
  | 'hierarchy.primary'
  | 'state.unlabelled'
  | 'state.green'
  | 'language.titleCase'
  | 'language.buttonWords'
  | 'language.terms'
  | 'spacing.scale'
  | 'spacing.type'
  | 'palette.contrastLight'
  | 'palette.contrastDark'
  | 'agent.delivery'
  | 'agent.rawData'
  | 'agent.question';

const limitsFile = z.strictObject({
  width: z.number().int().positive(),
  fold: z.number().int().positive(),
  reviewers: z.number().int().positive(),
  rules: z.strictObject({
    greyChroma: z.number(),
    greenHue: z.tuple([z.number(), z.number()]),
    labelGap: z.number(),
    minRegion: z.number(),
    spacingScale: z.array(z.number()),
    typeScale: z.array(z.number()),
    maxPrimary: count,
    maxButtonWords: count,
    internalTerms: z.array(z.string()),
    properNouns: z.array(z.string()),
    contrast: z.strictObject({ body: z.number(), large: z.number(), icon: z.number() }),
  }),
  limits: z.strictObject({ boxes: count, fontSizes: count, fontWeights: count, colors: count, controls: count, words: count }),
});

export type Limits = z.infer<typeof limitsFile>;

export const readLimits = async (): Promise<Limits> => limitsFile.parse(JSON.parse(await readFile(new URL('limits.json', import.meta.url), 'utf8')));

type Gate = {
  readonly id: GateId;
  readonly label: string;
  readonly value: (captured: Captured) => number;
  readonly limit: (limits: Limits) => number;
  readonly items: (captured: Captured) => readonly Item[];
};

const clutterLabels: Readonly<Record<ClutterKey, string>> = {
  boxes: 'boxed regions',
  fontSizes: 'distinct font sizes',
  fontWeights: 'distinct font weights',
  colors: 'non-grey colors',
  controls: 'controls outside the top bar',
  words: 'words above the fold',
};

const clutterGate = (key: ClutterKey): Gate => ({
  id: `clutter.${key}`,
  label: clutterLabels[key],
  value: captured => captured.light.clutter[key],
  limit: limits => limits.limits[key],
  items: () => [],
});

const listGate = (id: GateId, label: string, pick: (captured: Captured) => { readonly count: number; readonly items: readonly Item[] }, limit: (limits: Limits) => number = () => 0): Gate => ({
  id,
  label,
  value: captured => pick(captured).count,
  limit,
  items: captured => pick(captured).items,
});

const gates: readonly Gate[] = [
  ...clutterKeys.map(clutterGate),
  listGate('hierarchy.primary', 'primary-styled buttons', c => c.light.primaryButtons, limits => limits.rules.maxPrimary),
  listGate('state.unlabelled', 'state colors without a text label', c => c.light.unlabelledState),
  listGate('state.green', 'green outside landed', c => c.light.greenOutsideLanded),
  listGate('language.titleCase', 'title-case headings', c => c.light.titleCaseHeadings),
  listGate('language.buttonWords', 'button labels over 4 words', c => c.light.longButtonLabels),
  listGate('language.terms', 'internal terms', c => c.light.internalTerms),
  listGate('spacing.scale', 'margins, paddings, and gaps off the scale', c => c.light.spacingOffScale),
  listGate('spacing.type', 'font sizes off the type scale', c => c.light.typeOffScale),
  listGate('palette.contrastLight', 'text or icons below contrast, light theme', c => c.light.contrast),
  listGate('palette.contrastDark', 'text or icons below contrast, dark theme', c => c.dark.contrast),
  listGate('agent.delivery', 'messages you sent with no delivery state', c => c.light.undeliveredMessages),
  listGate('agent.rawData', 'raw JSON or stack traces in view', c => c.light.rawData),
  listGate('agent.question', 'open questions with no answer control in view', c => c.light.unansweredQuestions),
];

export type Judged = { readonly id: GateId; readonly label: string; readonly value: number; readonly limit: number; readonly passed: boolean; readonly items: readonly Item[] };

export const judge = (captured: Captured, limits: Limits): readonly Judged[] =>
  gates.map(gate => {
    const value = gate.value(captured);
    const limit = gate.limit(limits);
    return { id: gate.id, label: gate.label, value, limit, passed: value <= limit, items: gate.items(captured) };
  });

export const isClutter = (judged: Judged): boolean => judged.id.startsWith('clutter.');

export const verdict = (judged: Judged): string => {
  const first = judged.items[0];
  return `${String(judged.value)} ${judged.passed ? '<=' : '>'} ${String(judged.limit)} ${judged.label}${first === undefined ? '' : `, first at [${first.box.join(', ')}]: ${first.what}`}`;
};

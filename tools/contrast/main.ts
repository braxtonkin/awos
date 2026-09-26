import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tokensFile = 'shared/ui/tokens.ts';
const floors = { body: 4.5, large: 3, icon: 3 } as const;

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

const tokens = z.object({
  palettes: z.record(z.enum(['light', 'dark']), z.record(z.string(), hex)),
  pairs: z.array(z.strictObject({ text: z.string(), on: z.string(), size: z.enum(['body', 'large', 'icon']) })).min(1),
});

const channel = (value: number): number => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: string): number => {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(start => channel(Number.parseInt(color.slice(start, start + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

const loaded: unknown = await import(pathToFileURL(join(root, tokensFile)).href);
const { palettes, pairs } = tokens.parse(loaded);

const violations = Object.entries(palettes).flatMap(([theme, palette]) =>
  pairs.flatMap(pair => {
    const text = palette[pair.text];
    const on = palette[pair.on];
    if (text === undefined || on === undefined) return [`${tokensFile} ${theme} pairs ${pair.text} with ${pair.on}, and the palette lacks one of them`];
    const measured = ratio(text, on);
    const floor = floors[pair.size];
    return measured >= floor ? [] : [`${tokensFile} ${theme} ${pair.text} on ${pair.on} is ${measured.toFixed(2)} to 1, under the ${pair.size} floor of ${String(floor)} to 1`];
  }),
);

for (const violation of violations) process.stdout.write(`${violation}\n`);
process.exitCode = violations.length === 0 ? 0 : 1;

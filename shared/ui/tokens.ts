export const colorNames = ['ground', 'surface', 'surface-2', 'ink', 'muted', 'faint', 'rule', 'rule-strong', 'run', 'run-soft', 'pass', 'pass-soft', 'fail', 'fail-soft', 'attn', 'attn-soft'] as const;

export type ColorName = (typeof colorNames)[number];

export type Palette = Readonly<Record<ColorName, string>>;

export const themes = ['light', 'dark'] as const;

export type ThemeName = (typeof themes)[number];

export const palettes: Readonly<Record<ThemeName, Palette>> = {
  light: {
    ground: '#f6f6f7',
    surface: '#ffffff',
    'surface-2': '#eeeef0',
    ink: '#16161a',
    muted: '#55555e',
    faint: '#666670',
    rule: '#dddde1',
    'rule-strong': '#b3b3bb',
    run: '#2c5bcc',
    'run-soft': '#e5ecfb',
    pass: '#1f7548',
    'pass-soft': '#e2f2e8',
    fail: '#b3261e',
    'fail-soft': '#fbe6e4',
    attn: '#935405',
    'attn-soft': '#faeedc',
  },
  dark: {
    ground: '#0e0e10',
    surface: '#161618',
    'surface-2': '#1e1e21',
    ink: '#ededf0',
    muted: '#a3a3ab',
    faint: '#91919a',
    rule: '#29292d',
    'rule-strong': '#45454b',
    run: '#7ba2ff',
    'run-soft': '#1b2542',
    pass: '#56c08a',
    'pass-soft': '#15291e',
    fail: '#f0766c',
    'fail-soft': '#3b1b19',
    attn: '#e5a74d',
    'attn-soft': '#33261a',
  },
};

export type Size = 'body' | 'large' | 'icon';

export type Pair = { readonly text: ColorName; readonly on: ColorName; readonly size: Size };

const onEveryGround = (text: ColorName, size: Size): readonly Pair[] => (['ground', 'surface', 'surface-2'] as const).map(on => ({ text, on, size }));

export const pairs: readonly Pair[] = [
  ...onEveryGround('ink', 'body'),
  ...onEveryGround('muted', 'body'),
  ...onEveryGround('faint', 'body'),
  ...onEveryGround('run', 'body'),
  ...onEveryGround('fail', 'body'),
  ...onEveryGround('attn', 'body'),
  ...onEveryGround('pass', 'icon'),
  { text: 'run', on: 'run-soft', size: 'body' },
  { text: 'fail', on: 'fail-soft', size: 'body' },
  { text: 'attn', on: 'attn-soft', size: 'body' },
  { text: 'surface', on: 'ink', size: 'body' },
];

export const color = (name: ColorName): string => `var(--${name})`;

const variables = (palette: Palette): string => colorNames.map(name => `--${name}: ${palette[name]};`).join(' ');

export const pageCss = [
  `:root { ${variables(palettes.light)} color-scheme: light; }`,
  `@media (prefers-color-scheme: dark) { :root { ${variables(palettes.dark)} color-scheme: dark; } }`,
  '* { box-sizing: border-box; }',
  'html, body, h1, h2, h3, p { margin: 0; }',
  'body { min-height: 100vh; display: flex; flex-direction: column; background: var(--ground); color: var(--ink); font-size: 14px; line-height: 20px; -webkit-font-smoothing: antialiased; }',
  'body, button, input, textarea, select { font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif; }',
  'button, input, textarea, select { font-size: inherit; color: inherit; }',
  '.mono, pre { font-family: var(--font-mono), ui-monospace, monospace; font-size: 12px; }',
  '.hov:hover { background: var(--surface-2); }',
  ':focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }',
  '.pulse { animation: pulse 1.4s ease-in-out infinite; }',
  '@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }',
  '@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }',
  'p { text-wrap: pretty; }',
].join('\n');

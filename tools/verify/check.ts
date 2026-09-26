export type Check = {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
};

export type Observed = 'passed' | 'failed' | 'n/a';

export type Info = {
  readonly name: string;
  readonly observed: Observed;
  readonly detail: string;
};

export type Line = Check | Info;

export type Scenario = {
  readonly name: string;
  readonly summary: string;
  readonly run: (args: readonly string[]) => Promise<readonly Line[]>;
  readonly nightly?: (day: number) => readonly (readonly string[])[];
};

export const pass = (name: string, detail: string): Check => ({ name, passed: true, detail });

export const fail = (name: string, detail: string): Check => ({ name, passed: false, detail });

export const info = (name: string, observed: Observed, detail: string): Info => ({ name, observed, detail });

export const asInfo = (check: Check): Info => info(check.name, check.passed ? 'passed' : 'failed', check.detail);

export const isCheck = (line: Line): line is Check => 'passed' in line;

export const checksOf = (lines: readonly Line[]): readonly Check[] => lines.filter(isCheck);

export type Rendered = { readonly text: string; readonly exitCode: 0 | 1 };

const withDetail = (detail: string): string => (detail === '' ? '' : `  (${detail})`);

const rendered = (line: Line): string =>
  isCheck(line) ? `${line.passed ? 'PASS' : 'FAIL'}  ${line.name}${withDetail(line.detail)}` : `INFO  ${line.name}  (${line.observed}${line.detail === '' ? '' : `: ${line.detail}`})`;

export function render(lines: readonly Line[]): Rendered {
  const checks = checksOf(lines);
  const passed = checks.filter(check => check.passed).length;
  const notes = lines.length - checks.length;
  const summary = `${String(passed)} of ${String(checks.length)} checks passed${notes === 0 ? '' : `, and ${String(notes)} info lines decide nothing`}`;
  return { text: `${[...lines.map(rendered), summary].join('\n')}\n`, exitCode: passed === checks.length ? 0 : 1 };
}

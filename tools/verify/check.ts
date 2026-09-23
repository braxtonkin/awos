export type Check = {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
};

export type Scenario = {
  readonly name: string;
  readonly summary: string;
  readonly run: (args: readonly string[]) => Promise<readonly Check[]>;
};

export const pass = (name: string, detail: string): Check => ({ name, passed: true, detail });

export const fail = (name: string, detail: string): Check => ({ name, passed: false, detail });

type Workspace = { readonly kind: 'workspace'; readonly run: string } | { readonly kind: 'workspace-ci' };

type Request = { readonly repository: { readonly fastTestCommand: string | null } };

export const testsOnly = {
  name: 'tests-only',
  start: ({ repository }: Request): Promise<Workspace> =>
    Promise.resolve(repository.fastTestCommand === null ? { kind: 'workspace-ci' } : { kind: 'workspace', run: repository.fastTestCommand }),
  stop: (): Promise<void> => Promise.resolve(),
};

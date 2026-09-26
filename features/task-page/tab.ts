export const tabs = ['evidence', 'attempts'] as const;

export type Tab = (typeof tabs)[number];

export const tabOf = (asked: unknown): Tab => tabs.find(tab => tab === asked) ?? 'evidence';

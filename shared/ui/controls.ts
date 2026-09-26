import { color } from './tokens.ts';

export const secondary = { padding: '6px 12px', borderRadius: 6, border: `1px solid ${color('rule-strong')}`, background: color('surface'), color: color('ink'), fontSize: 13, fontWeight: 500, cursor: 'pointer' } as const;

export const primary = { ...secondary, border: `1px solid ${color('ink')}`, background: color('ink'), color: color('surface') } as const;

export const field = { width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${color('rule-strong')}`, background: color('surface'), resize: 'vertical', lineHeight: '20px' } as const;

export const hint = { fontSize: 12, color: color('muted') } as const;

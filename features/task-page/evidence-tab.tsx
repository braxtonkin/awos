import { clock } from '../../shared/ui/clock.ts';
import { color } from '../../shared/ui/tokens.ts';
import type { AttemptRow, Evidence } from './read.ts';
import { stepName } from './time.ts';

export const tryOf = (attempts: readonly AttemptRow[], attempt: string): number => {
  const shown = attempts.find(each => each.id === attempt);
  return attempts.filter(each => each.step === shown?.step && BigInt(each.id) <= BigInt(attempt)).length;
};

const code = { margin: '8px 0 0', padding: '12px 16px', borderRadius: 8, background: color('surface-2'), fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 480, overflow: 'auto' } as const;

type EvidenceTabProps = { readonly evidence: readonly Evidence[]; readonly attempts: readonly AttemptRow[]; readonly zone: string };

export function EvidenceTab({ evidence, attempts, zone }: EvidenceTabProps) {
  if (evidence.length === 0) return <p style={{ margin: 0, color: color('muted') }}>No step has recorded evidence yet. A step records it when its attempt ends.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {evidence.map(row => (
        <article key={row.attempt} data-evidence={row.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {`${stepName(row.step)}, try ${String(tryOf(attempts, row.attempt))}`}
            <span style={{ fontWeight: 400, color: color('muted') }}>{` · recorded at ${clock(row.recordedAt, zone)}`}</span>
          </h3>
          {row.facts.length === 0 ? null : (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', fontSize: 13 }}>
              {row.facts.map(fact => [
                <dt key={`${fact.name}-name`} style={{ color: color('muted') }}>
                  {fact.name}
                </dt>,
                <dd key={`${fact.name}-value`} style={{ margin: 0 }}>
                  {fact.text}
                </dd>,
              ])}
            </dl>
          )}
          {row.blocks.map(block => (
            <details key={block.name} data-field={block.name} style={{ borderTop: `1px solid ${color('rule')}`, paddingTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>{block.name}</summary>
              <pre style={code}>
                <code>{block.text}</code>
              </pre>
            </details>
          ))}
        </article>
      ))}
    </div>
  );
}

import { clock } from '../../shared/ui/clock.ts';
import { color } from '../../shared/ui/tokens.ts';
import { Folded } from './folded.tsx';
import type { AttemptSummary, Evidence, Field } from './protocol.ts';
import { Reproduced } from './reproduction.tsx';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';

const code = { margin: '8px 0 0', padding: '12px 16px', borderRadius: 8, background: color('surface-2'), fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 480, overflow: 'auto' } as const;

function Fields({ blocks, facts }: { readonly blocks: readonly Field[]; readonly facts: readonly Field[] }) {
  return (
    <>
      {facts.length === 0 ? null : (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', fontSize: 13 }}>
          {facts.map(fact => [
            <dt key={`${fact.name}-name`} style={{ color: color('muted') }}>
              {fact.name}
            </dt>,
            <dd key={`${fact.name}-value`} style={{ margin: 0 }}>
              {fact.text}
            </dd>,
          ])}
        </dl>
      )}
      {blocks.map(block => (
        <Folded key={block.name} field={block.name} style={{ borderTop: `1px solid ${color('rule')}`, paddingTop: 8 }} summary={<summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>{block.name}</summary>}>
          <pre style={code}>
            <code>{block.text}</code>
          </pre>
        </Folded>
      ))}
    </>
  );
}

type EntryProps = { readonly row: Evidence; readonly attempts: readonly AttemptSummary[]; readonly zone: string };

function Entry({ row, attempts, zone }: EntryProps) {
  return (
    <article data-evidence={row.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        {`${stepName(row.step)}, try ${String(numbered(attempts, row.attempt))}`}
        <span style={{ fontWeight: 400, color: color('muted') }}>{` · recorded at ${clock(row.recordedAt, zone)}`}</span>
      </h3>
      {row.shown.kind === 'reproduction' ? <Reproduced reproduction={row.shown.reproduction} /> : <Fields blocks={row.shown.blocks} facts={row.shown.facts} />}
    </article>
  );
}

type EvidenceTabProps = { readonly evidence: readonly Evidence[]; readonly attempts: readonly AttemptSummary[]; readonly zone: string };

export function EvidenceTab({ evidence, attempts, zone }: EvidenceTabProps) {
  if (evidence.length === 0) return <p style={{ margin: 0, color: color('muted') }}>No step has recorded evidence yet. A step records it when its attempt ends.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {[...Map.groupBy(evidence, row => row.step).values()].map(rows => {
        const newest = rows.at(-1);
        const earlier = rows.slice(0, -1);
        return newest === undefined ? null : (
          <div key={newest.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Entry row={newest} attempts={attempts} zone={zone} />
            {earlier.length === 0 ? null : (
              <Folded field="earlier" summary={<summary style={{ cursor: 'pointer', fontSize: 13, color: color('muted') }}>{earlier.length === 1 ? '1 earlier try' : `${String(earlier.length)} earlier tries`}</summary>}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24, marginTop: 16 }}>
                  {earlier.map(row => (
                    <Entry key={row.attempt} row={row} attempts={attempts} zone={zone} />
                  ))}
                </div>
              </Folded>
            )}
          </div>
        );
      })}
    </div>
  );
}

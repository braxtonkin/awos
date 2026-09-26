import { markLabels, type Mark } from '../task-status.ts';
import { color, type ColorName } from './tokens.ts';

const tones: Readonly<Record<Mark, ColorName>> = { running: 'run', 'needs-you': 'attn', failed: 'fail', stopped: 'muted', landed: 'pass' };

const labelTone = (mark: Mark): ColorName => (mark === 'landed' ? 'ink' : tones[mark]);

export function StatusMarks({ marks }: { readonly marks: readonly Mark[] }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flex: 'none' }}>
      {marks.map(mark => (
        <span key={mark} data-mark={mark} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, color: color(labelTone(mark)) }}>
          <span aria-hidden="true" className={mark === 'running' ? 'pulse' : undefined} style={{ width: 8, height: 8, borderRadius: '50%', background: color(tones[mark]), flex: 'none' }} />
          {markLabels[mark]}
        </span>
      ))}
    </span>
  );
}

import type { RanScript, Reproduction, Side } from '../../shared/reproduction.ts';
import { color } from '../../shared/ui/tokens.ts';
import { Folded } from './folded.tsx';

type Ran = Extract<Reproduction, { readonly state: 'ran' }>;

const code = { margin: 0, padding: '12px 16px', borderRadius: 8, background: color('surface-2'), fontSize: 12, lineHeight: '20px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' } as const;

const endedWords = (ran: RanScript): string => (ran.timedOut ? 'ran out of time' : ran.exitCode === null ? 'ended without an exit code' : `exited ${String(ran.exitCode)}`);

const setupFailedWords = (setup: RanScript): string => (setup.timedOut || setup.exitCode === null ? endedWords(setup) : `failed (exit ${String(setup.exitCode)})`);

const setupFailed = (setup: RanScript | null): setup is RanScript => setup !== null && (setup.timedOut || setup.exitCode !== 0);

const scriptExit = (side: Side): number | null => (side.checkout !== null || setupFailed(side.setup) || side.run === null || side.run.timedOut ? null : side.run.exitCode);

function clauseOf(side: Side, where: string, still: boolean): string {
  if (side.checkout !== null) return `did not run on ${where}, because AutoWorker could not check it out`;
  if (setupFailed(side.setup)) return `did not run on ${where}, because its setup command ${setupFailedWords(side.setup)}`;
  if (side.run === null) return `did not run on ${where}`;
  if (side.run.timedOut) return `ran out of time on ${where}`;
  if (side.run.exitCode === null) return `ended without an exit code on ${where}`;
  return side.run.exitCode === 0 ? `passed on ${where} (exit 0)` : `${still ? 'still failed' : 'failed'} on ${where} (exit ${String(side.run.exitCode)})`;
}

function sentenceOf(given: Ran): string {
  const base = scriptExit(given.base);
  const change = scriptExit(given.change);
  const still = base !== null && base !== 0 && change !== null && change !== 0;
  const unshown = base === 0 ? ', so it did not show the bug' : '';
  return `The reproduction ${clauseOf(given.base, 'the base commit', false)} and ${clauseOf(given.change, 'the change', still)}${unshown}.`;
}

function Output({ name, text }: { readonly name: string; readonly text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 12, color: color('muted') }}>{name}</span>
      <pre style={code}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Run({ name, side }: { readonly name: string; readonly side: Side }) {
  return (
    <section aria-label={name} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{name}</h4>
      <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
        {side.commit}
      </span>
      {side.checkout === null ? null : <Output name="Checkout" text={side.checkout} />}
      {side.setup === null ? null : <Output name={`Setup ${endedWords(side.setup)}`} text={side.setup.output} />}
      {side.run === null ? null : <Output name={`Script ${endedWords(side.run)}`} text={side.run.output} />}
    </section>
  );
}

export function Reproduced({ reproduction }: { readonly reproduction: Reproduction }) {
  if (reproduction.state === 'no_script') return <p style={{ margin: 0, fontSize: 13 }}>{`AutoWorker ran no reproduction, because ${reproduction.reason}.`}</p>;
  return (
    <Folded field="reproduction" summary={<summary style={{ cursor: 'pointer', fontSize: 13 }}>{sentenceOf(reproduction)}</summary>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
        <Output name="Script" text={reproduction.script} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
          <Run name="Base commit" side={reproduction.base} />
          <Run name="Change" side={reproduction.change} />
        </div>
      </div>
    </Folded>
  );
}

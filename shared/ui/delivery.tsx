import { deliveryOf, type Said } from '../said.ts';
import { clock } from './clock.ts';
import { color } from './tokens.ts';

const stages = [
  { label: 'Sent', at: (entry: Said) => entry.at },
  { label: 'Received', at: (entry: Said) => entry.receivedAt },
  { label: 'Acted on', at: (entry: Said) => entry.actedAt },
] as const;

export function DeliveryLine({ entry, zone }: { readonly entry: Said; readonly zone: string }) {
  const reached = stages.flatMap(stage => {
    const at = stage.at(entry);
    return at === null ? [] : [`${stage.label} ${clock(at, zone)}`];
  });
  const waiting = entry.answer === 'waiting' ? ['waiting for the engine'] : [];
  return (
    <span data-delivered={deliveryOf(entry)} style={{ fontSize: 12, color: color('muted') }}>
      {[...reached, ...waiting].join(' · ')}
    </span>
  );
}

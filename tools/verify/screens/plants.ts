import type { GateId } from './gates.ts';

export const plantedFixture = 'task-a-revised';

export const plantAnchor = 'Retry 429 responses in the billing client</h1>';

const repeat = (times: number, html: string): string => html.repeat(times);

export const plants: Readonly<Record<GateId, string>> = {
  'clutter.boxes': `<div style="display:flex;gap:8px">${repeat(4, '<span style="display:block;width:24px;height:24px;border:1px solid #888888"></span>')}</div>`,
  'clutter.fontSizes': '<p style="font-size:20px;line-height:24px">Retries left</p>',
  'clutter.fontWeights': '<p style="font-weight:700">Retries left</p>',
  'clutter.colors': '<p><span style="color:#7a1fa2">Queued</span> <span style="color:#8b4513">Paused</span> <span style="color:#00696b">Held</span></p>',
  'clutter.controls': `<div style="display:flex;gap:8px">${repeat(9, '<input type="checkbox">')}</div>`,
  'clutter.words': '<p>The client gives up after one 429 today, so each retry now waits for the header and stops after thirty seconds.</p>',
  'hierarchy.primary': '<button type="button" style="align-self:flex-start;background:#16161a;color:#ffffff;padding:8px 12px;border:0;border-radius:6px">Approve</button>',
  'state.unlabelled': '<div style="padding:24px 0"><span style="display:block;width:8px;height:8px;border-radius:4px;background:#2c5bcc"></span></div>',
  'state.green': '<p><span style="color:#1f7548">Running</span></p>',
  'language.titleCase': '<h2 style="font-size:20px;line-height:24px">Retry Failed Requests Now</h2>',
  'language.buttonWords': '<button type="button" style="align-self:flex-start">Send this note to agent</button>',
  'language.terms': '<p>Waiting for the lease to expire.</p>',
  'spacing.scale': '<div style="display:flex;gap:14px"><span>Retries</span><span>3</span></div>',
  'spacing.type': '<p style="font-size:16px">Retries left</p>',
  'palette.contrastLight': '<p style="color:#9a9aa3">Checked at 14:01</p>',
  'palette.contrastDark': '<style>.plant-dim { color: #55555e; } @media (prefers-color-scheme: dark) { .plant-dim { color: #707070; } }</style><p class="plant-dim">Checked at 14:01</p>',
  'agent.delivery': '<div data-msg="person"><p>Also check a 503.</p></div>',
  'agent.rawData': '<pre style="margin:0;font-family:var(--mono);font-size:13px">{"status": 429, "retry": true}</pre>',
  'agent.question': '<div data-question="open"><p>Which cap do you want?</p></div>',
};

export const plantIds = Object.keys(plants).filter((id): id is GateId => id in plants);

export function plant(html: string, ids: readonly GateId[]): string {
  if (html.split(plantAnchor).length !== 2) throw new Error(`${plantedFixture}.html must hold "${plantAnchor}" exactly once to take a plant`);
  return html.replace(plantAnchor, `${plantAnchor}${ids.map(id => plants[id]).join('')}`);
}

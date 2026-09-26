const partsIn = (iso: string, zone: string, options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(new Date(iso));

export const clock = (iso: string, zone: string): string => partsIn(iso, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const day = (iso: string, zone: string): string => partsIn(iso, zone, { weekday: 'short', day: 'numeric', month: 'short' });

export const nameOf = (machineName: string): string => {
  const spaced = machineName.replaceAll(/[-_]+/g, ' ');
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

export type Sentences = { readonly first: string; readonly rest: string };

export const splitFirst = (text: string): Sentences => {
  const end = text.search(/[.?!]\s/);
  return end === -1 ? { first: text, rest: '' } : { first: text.slice(0, end + 1), rest: text.slice(end + 1) };
};

const dayMs = 24 * 60 * 60_000;

const partsIn = (iso: string, zone: string, options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(new Date(iso));

export const clock = (iso: string, zone: string): string => partsIn(iso, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const moment = (iso: string, zone: string, now: string): string => {
  const sameDay = partsIn(iso, zone, { dateStyle: 'short' }) === partsIn(now, zone, { dateStyle: 'short' });
  return sameDay ? clock(iso, zone) : partsIn(iso, zone, { day: 'numeric', month: 'short' });
};

export const day = (iso: string, zone: string): string => partsIn(iso, zone, { weekday: 'short', day: 'numeric', month: 'short' });

export const duration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${String(Math.max(1, Math.round(ms / 1000)))} s`;
  if (minutes < 60) return `${String(minutes)} min`;
  if (ms < dayMs) return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`;
  return `${String(Math.floor(ms / dayMs))} d ${String(Math.round((ms % dayMs) / 3_600_000))} h`;
};

export const nameOf = (machineName: string): string => {
  const spaced = machineName.replaceAll(/[-_]+/g, ' ');
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

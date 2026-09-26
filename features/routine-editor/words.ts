const hourMinutes = 60;

export const interval = (minutes: number): string => {
  if (minutes === 1) return 'Every minute';
  if (minutes % hourMinutes !== 0) return `Every ${String(minutes)} minutes`;
  const hours = minutes / hourMinutes;
  return hours === 1 ? 'Every hour' : `Every ${String(hours)} hours`;
};

const day = (iso: string, zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(iso));

export const when = (iso: string, now: string, zone: string): string => {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(iso));
  if (day(iso, zone) === day(now, zone)) return `Today ${time}`;
  return `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: zone }).format(new Date(iso))} ${time}`;
};

export const stepName = (step: string): string => `${step.charAt(0).toUpperCase()}${step.slice(1)}`;

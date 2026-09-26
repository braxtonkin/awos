export const clock = (iso: string, zone: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(iso));

export const stepName = (step: string): string => `${step.charAt(0).toUpperCase()}${step.slice(1)}`;

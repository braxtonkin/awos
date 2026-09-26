export const clock = (iso: string, zone: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(iso));

export const day = (iso: string, zone: string): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(new Date(iso));

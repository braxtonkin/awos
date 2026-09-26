import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { people } from '../../../shared/people.ts';
import { pageCss } from '../../../shared/ui/tokens.ts';
import { TopBar } from '../../../shared/ui/top-bar.tsx';
import { database } from '../database.ts';
import { acting } from '../identity.ts';
import { pick } from './acting.ts';

const sans = localFont({ src: '../../../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2', variable: '--font-sans', weight: '400 600', display: 'block' });

const mono = localFont({ src: '../../../node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2', variable: '--font-mono', weight: '400 500', display: 'block' });

export const dynamic = 'force-dynamic';

export const metadata = { title: 'AutoWorker' };

export default async function Layout({ children }: { readonly children: ReactNode }) {
  const everyone = await people(database());
  const id = await acting();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      </head>
      <body>
        <TopBar people={everyone} acting={everyone.find(person => person.id === id)} pick={pick} />
        {children}
      </body>
    </html>
  );
}

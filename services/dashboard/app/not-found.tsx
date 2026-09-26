import { color } from '../../../shared/ui/tokens.ts';

export default function NotFound() {
  return (
    <main style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>Nothing is here</h1>
      <p style={{ color: color('muted') }}>No page has this address.</p>
    </main>
  );
}

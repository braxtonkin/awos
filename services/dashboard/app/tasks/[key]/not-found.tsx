import { color } from '../../../../../shared/ui/tokens.ts';

export default function TaskNotFound() {
  return (
    <main style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600 }}>No task has that key</h1>
      <p style={{ color: color('muted') }}>Check the key in the address. A task gets its key from its ticket.</p>
    </main>
  );
}

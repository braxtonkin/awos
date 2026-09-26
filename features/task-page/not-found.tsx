import { color } from '../../shared/ui/tokens.ts';

type TaskNotFoundProps = { readonly open: (form: FormData) => Promise<void> };

export function TaskNotFound({ open }: TaskNotFoundProps) {
  const field = { height: 32, padding: '0 12px', borderRadius: 6, border: `1px solid ${color('rule')}`, background: color('surface') } as const;
  return (
    <main style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 640 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 600 }}>No task has that key</h1>
        <p style={{ margin: 0, color: color('muted') }}>A task takes its key from its ticket. Check the key, or open a task by its key.</p>
      </div>
      <form action={open} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor="task-key" style={{ fontSize: 13, color: color('muted') }}>
          Task key
        </label>
        <input id="task-key" name="key" required autoComplete="off" spellCheck={false} style={{ ...field, width: 200 }} />
        <button type="submit" className="hov" style={{ ...field, fontWeight: 500, cursor: 'pointer' }}>
          Open task
        </button>
      </form>
    </main>
  );
}

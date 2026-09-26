'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';

type FoldedProps = { readonly summary: ReactNode; readonly children: ReactNode; readonly field?: string; readonly style?: CSSProperties };

export function Folded({ summary, children, field, style }: FoldedProps) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-field={field}
      style={style}
      onToggle={event => {
        setOpen(event.currentTarget.open);
      }}
    >
      {summary}
      {open ? children : null}
    </details>
  );
}

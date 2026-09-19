import type { ReactNode } from 'react';

export type WorkspaceMode = 'default' | 'setup';

export interface WorkspaceProps {
  readonly children: ReactNode;
  readonly header: ReactNode;
  readonly labelledBy?: string;
  readonly mode?: WorkspaceMode;
}

export function Workspace({ children, header, labelledBy, mode = 'default' }: WorkspaceProps) {
  const contentWidth =
    mode === 'setup' ? 'mx-auto w-full max-w-[var(--or-setup-content-max-width)]' : 'w-full';

  return (
    <main
      aria-labelledby={labelledBy}
      className="min-w-0 flex-1 scroll-mt-[var(--or-shell-topbar-height)]"
      id="main-content"
      tabIndex={-1}
    >
      <section className="min-h-full min-w-0 overflow-hidden rounded-[var(--or-radius-lg)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-workspace)]">
        <header className="border-b border-[var(--or-border-subtle)]">
          <div
            className={`${contentWidth} px-[var(--or-space-4)] py-[var(--or-space-5)] sm:px-[var(--or-space-6)] sm:py-[var(--or-space-6)]`}
          >
            {header}
          </div>
        </header>
        <div
          className={`${contentWidth} min-w-0 px-[var(--or-space-4)] py-[var(--or-space-5)] sm:px-[var(--or-space-6)] sm:py-[var(--or-space-6)]`}
        >
          {children}
        </div>
      </section>
    </main>
  );
}

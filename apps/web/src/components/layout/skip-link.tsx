export interface SkipLinkProps {
  readonly targetId?: string;
}

export function SkipLink({ targetId = 'main-content' }: SkipLinkProps) {
  return (
    <a
      className="fixed top-[var(--or-space-2)] left-[var(--or-space-2)] z-[var(--or-z-tooltip)] -translate-y-[calc(100%+var(--or-space-4))] rounded-[var(--or-button-radius)] border border-[var(--or-border-selected)] bg-[var(--or-bg-overlay)] px-[var(--or-button-padding-inline-md)] py-[var(--or-space-2)] font-medium text-[var(--or-text-primary)] transition-transform duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] focus:translate-y-0 motion-reduce:transition-none"
      href={`#${targetId}`}
    >
      Skip to content
    </a>
  );
}

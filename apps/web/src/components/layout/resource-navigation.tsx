import type { MouseEvent } from 'react';

export type ResourceNavigationIcon =
  'accounts' | 'dashboard' | 'jobs' | 'media' | 'settings' | 'setup' | 'sources' | 'workflows';

export interface ResourceNavigationItem {
  readonly href: string;
  readonly icon: ResourceNavigationIcon;
  readonly label: string;
}

export interface ResourceNavigationProps {
  readonly currentPath: string;
  readonly items: readonly ResourceNavigationItem[];
  readonly mode: 'compact' | 'rail';
  readonly onNavigate: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

function NavigationIcon({ icon }: { readonly icon: ResourceNavigationIcon }) {
  const commonProps = {
    'aria-hidden': true,
    className: 'size-[var(--or-icon-lg)] shrink-0',
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.75,
    viewBox: '0 0 24 24',
  };

  switch (icon) {
    case 'dashboard':
      return (
        <svg {...commonProps}>
          <rect height="7" rx="1" width="7" x="3" y="3" />
          <rect height="7" rx="1" width="7" x="14" y="3" />
          <rect height="7" rx="1" width="7" x="3" y="14" />
          <rect height="7" rx="1" width="7" x="14" y="14" />
        </svg>
      );
    case 'setup':
      return (
        <svg {...commonProps}>
          <path d="M14.5 6.5 17.5 3.5a4 4 0 0 1-5 5L5 16v3h3l7.5-7.5a4 4 0 0 1 5-5l-3 3" />
        </svg>
      );
    case 'accounts':
      return (
        <svg {...commonProps}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.5a3 3 0 0 1 0 5.5M17 15a4.5 4.5 0 0 1 3.5 4" />
        </svg>
      );
    case 'sources':
      return (
        <svg {...commonProps}>
          <path d="M4 5h16v12H4zM8 21h8M12 9v6M9.5 12.5 12 15l2.5-2.5" />
        </svg>
      );
    case 'media':
      return (
        <svg {...commonProps}>
          <rect height="14" rx="2" width="18" x="3" y="5" />
          <path d="m10 9 5 3-5 3V9Z" />
        </svg>
      );
    case 'workflows':
      return (
        <svg {...commonProps}>
          <circle cx="5" cy="12" r="2" />
          <circle cx="19" cy="6" r="2" />
          <circle cx="19" cy="18" r="2" />
          <path d="M7 12h3c3 0 3-6 6-6h1M7 12h3c3 0 3 6 6 6h1" />
        </svg>
      );
    case 'jobs':
      return (
        <svg {...commonProps}>
          <path d="M5 5h14M5 12h14M5 19h14" />
          <circle cx="8" cy="5" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="10" cy="19" r="1.5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.8-1L14.4 3h-4.8l-.4 3.1a8 8 0 0 0-1.8 1L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5l2 3.4 2.4-1a8 8 0 0 0 1.8 1l.4 3.1h4.8l.4-3.1a8 8 0 0 0 1.8-1l2.4 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z" />
        </svg>
      );
  }
}

export function ResourceNavigation({
  currentPath,
  items,
  mode,
  onNavigate,
}: ResourceNavigationProps) {
  const isRail = mode === 'rail';

  return (
    <nav
      aria-label="Primary navigation"
      className={
        isRail
          ? 'flex h-full flex-col items-center gap-[var(--or-space-1)] overflow-y-auto py-[var(--or-space-2)]'
          : 'flex gap-[var(--or-space-1)] overflow-x-auto border-b border-[var(--or-border-subtle)] bg-[var(--or-bg-shell)] px-[var(--or-space-3)] py-[var(--or-space-2)] lg:hidden'
      }
      data-navigation-mode={mode}
    >
      {items.map(({ href, icon, label }) => {
        const isCurrent = currentPath === href;
        const edgeClass = isRail
          ? 'inset-y-[var(--or-space-2)] left-0 w-[var(--or-nav-active-edge-width)]'
          : 'inset-x-[var(--or-space-2)] bottom-0 h-[var(--or-nav-active-edge-width)]';

        return (
          <a
            aria-current={isCurrent ? 'page' : undefined}
            className={`relative inline-flex shrink-0 items-center justify-center rounded-[var(--or-radius-sm)] border font-medium transition-[background-color,border-color,color] duration-[var(--or-duration-fast)] ease-[var(--or-ease-out)] active:bg-[var(--or-bg-selected)] motion-reduce:transition-none ${
              isRail
                ? 'size-[var(--or-nav-rail-control-size)] border-transparent'
                : 'min-h-[var(--or-target-mobile)] gap-[var(--or-space-2)] border-transparent px-[var(--or-space-3)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]'
            } ${
              isCurrent
                ? 'border-[var(--or-border-selected)] bg-[var(--or-bg-selected)] text-[var(--or-text-primary)]'
                : 'text-[var(--or-text-tertiary)] hover:border-[var(--or-border-default)] hover:bg-[var(--or-bg-hover)] hover:text-[var(--or-text-primary)]'
            }`}
            href={href}
            key={href}
            onClick={(event) => onNavigate(event, href)}
            title={isRail ? label : undefined}
          >
            {isCurrent && (
              <span
                aria-hidden="true"
                className={`absolute rounded-[var(--or-radius-full)] bg-[var(--or-border-selected)] ${edgeClass}`}
              />
            )}
            <NavigationIcon icon={icon} />
            <span className={isRail ? 'sr-only' : undefined}>{label}</span>
          </a>
        );
      })}
    </nav>
  );
}

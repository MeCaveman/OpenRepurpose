import type { HTMLAttributes, ReactNode } from 'react';

import { PlatformIdentity } from './platform-identity';

export interface PlatformSectionHeaderProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'title'
> {
  readonly description?: ReactNode;
  readonly headingId: string;
  readonly headingLevel?: 2 | 3;
  readonly platform: string;
  readonly title: ReactNode;
  readonly trailing?: ReactNode;
}

export function PlatformSectionHeader({
  className,
  description,
  headingId,
  headingLevel = 2,
  platform,
  title,
  trailing,
  ...props
}: PlatformSectionHeaderProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  return (
    <header
      {...props}
      className={`flex flex-col gap-[var(--or-space-4)] sm:flex-row sm:items-start sm:justify-between ${className ?? ''}`}
    >
      <div className="flex min-w-0 items-start gap-[var(--or-space-3)]">
        <PlatformIdentity platform={platform} showLabel={false} />
        <div className="min-w-0">
          <Heading
            className="break-words font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id={headingId}
          >
            {title}
          </Heading>
          {description !== undefined && (
            <p className="mt-[var(--or-space-1)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              {description}
            </p>
          )}
        </div>
      </div>
      {trailing !== undefined && <div className="shrink-0 self-start">{trailing}</div>}
    </header>
  );
}

export interface PageHeaderProps {
  readonly description: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly titleId?: string;
}

export function PageHeader({ description, eyebrow, title, titleId }: PageHeaderProps) {
  return (
    <div>
      <p className="font-semibold tracking-[var(--or-tracking-overline)] text-[var(--or-text-link)] uppercase [font-size:var(--or-type-micro-size)] [line-height:var(--or-type-micro-line)]">
        {eyebrow}
      </p>
      <h1
        className="mt-[var(--or-space-2)] max-w-[var(--or-setup-wide-max-width)] text-balance font-semibold tracking-[var(--or-tracking-page)] text-[var(--or-text-primary)] [font-size:var(--or-type-page-size)] [line-height:var(--or-type-page-line)]"
        id={titleId}
      >
        {title}
      </h1>
      <p className="mt-[var(--or-space-2)] max-w-[var(--or-setup-content-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
        {description}
      </p>
    </div>
  );
}

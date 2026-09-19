import { WorkflowRoute } from './workflow-route';
import type { WorkflowRouteData } from './workflow-route';
import { WorkflowStatus } from './workflow-status';

export interface WorkflowCardProps extends WorkflowRouteData {
  readonly enabled: boolean;
  readonly name: string;
  readonly sourceLabel: string;
}

export function WorkflowCard({
  destinations,
  enabled,
  name,
  source,
  sourceLabel,
  stages,
}: WorkflowCardProps) {
  return (
    <article className="rounded-[var(--or-setup-section-radius)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-surface)] p-[var(--or-pane-padding)]">
      <header className="flex flex-wrap items-start justify-between gap-[var(--or-space-3)]">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]">
            {name}
          </h3>
          <p className="mt-[var(--or-space-1)] truncate font-[family-name:var(--or-font-technical)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
            {sourceLabel}
          </p>
        </div>
        <WorkflowStatus enabled={enabled} />
      </header>
      <div className="mt-[var(--or-space-4)]">
        <WorkflowRoute
          destinations={destinations}
          source={source}
          {...(stages === undefined ? {} : { stages })}
        />
      </div>
    </article>
  );
}

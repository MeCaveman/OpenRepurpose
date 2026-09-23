import { useRef, useState } from 'react';

import {
  ResourceEmptyState,
  WorkflowCard,
  getPlatformMetadata,
  type WorkflowRouteData,
  type WorkflowRouteNodeData,
} from '../../components/patterns';
import { Alert, Badge, Button, Panel, Spinner } from '../../components/ui';
import { WorkflowEditor } from './workflow-editor';
import type { WorkflowDefinitionView, WorkflowEditorValue } from './workflow-editor';

export interface WorkflowAccountView {
  readonly capabilities: readonly string[];
  readonly displayName: string;
  readonly id: string;
  readonly provider: string;
  readonly status: string;
}

export interface WorkflowTargetView {
  readonly availability: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: string;
}

export interface WorkflowSourceView {
  readonly adapterId?: string;
  readonly displayName: string;
  readonly id: string;
  readonly status: string;
}

export interface WorkflowPresetIssueView {
  readonly code: string;
  readonly message: string;
  readonly severity: 'blocking' | 'warning';
}

export interface WorkflowPresetView {
  readonly description: string;
  readonly destinationIds: readonly string[];
  readonly id: 'obs-clip-short-form' | 'stream-clip-short-form';
  readonly issues: readonly WorkflowPresetIssueView[];
  readonly label: string;
  readonly status: 'blocked' | 'partial' | 'ready';
}

export interface WorkflowDestinationView {
  readonly accountId: string;
  readonly destinationId: string;
  readonly [key: string]: unknown;
}

export interface WorkflowView {
  readonly definition?: WorkflowDefinitionView;
  readonly destinations: readonly WorkflowDestinationView[];
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly remoteSource?: {
    readonly connectionId: string;
    readonly retentionPolicy?: { readonly durationSeconds?: number; readonly kind: string };
  };
  readonly sourceDirectory: string;
  readonly titleTemplate: string;
}

export interface WorkflowsPageProps {
  readonly accounts: readonly WorkflowAccountView[];
  readonly error: string | undefined;
  readonly isLoading: boolean;
  readonly metaTargets: readonly WorkflowTargetView[];
  readonly onApplyPreset: (id: WorkflowPresetView['id']) => Promise<WorkflowEditorValue>;
  readonly onCreateWorkflow: (value: WorkflowEditorValue) => Promise<void>;
  readonly onRetry: () => void;
  readonly sources: readonly WorkflowSourceView[];
  readonly presets: readonly WorkflowPresetView[];
  readonly workflows: readonly WorkflowView[];
}

function toWorkflowRouteData(workflow: WorkflowView): WorkflowRouteData {
  const sourceLabel =
    workflow.sourceDirectory.trim() ||
    workflow.remoteSource?.connectionId.trim() ||
    'Remote source';
  const nodeState = workflow.enabled ? ('default' as const) : ('disabled' as const);
  const sourceStep = workflow.definition?.steps.find((step) => step.kind === 'source');
  const watchedFolderDetail =
    sourceStep?.kind === 'source' && sourceStep.watchedFolder?.preset === 'obs_recording'
      ? 'OBS recording folder'
      : sourceStep?.kind === 'source' && sourceStep.watchedFolder?.preset === 'obs_replay_buffer'
        ? 'OBS Replay Buffer folder'
        : 'Watched folder';
  const source: WorkflowRouteNodeData = {
    detail: workflow.remoteSource === undefined ? watchedFolderDetail : 'Remote source',
    kind: 'source',
    label: sourceLabel,
    state: nodeState,
    ...(workflow.remoteSource === undefined ? { platform: 'local' } : {}),
  };
  const stages: WorkflowRouteNodeData[] = [];
  const destinations: WorkflowRouteNodeData[] = [];

  for (const step of workflow.definition?.steps ?? []) {
    if (step.kind === 'filter') {
      stages.push({ kind: 'filter', label: 'Filter', state: nodeState });
    } else if (step.kind === 'transform') {
      const fit = step.plan?.user.steps[0];
      stages.push({
        kind: 'transform',
        label: fit === undefined ? 'Pass-through' : `${fit.width} × ${fit.height}`,
        ...(fit === undefined ? {} : { detail: fit.mode }),
        state: nodeState,
      });
    } else if (step.kind === 'schedule') {
      stages.push({
        detail: step.scheduleId,
        kind: 'schedule',
        label: 'Schedule',
        state: nodeState,
      });
    } else if (step.kind === 'destination') {
      destinations.push({
        detail: step.destination.accountId || 'Account not selected',
        kind: 'destination',
        label: getPlatformMetadata(step.destination.destinationId).label,
        platform: step.destination.destinationId,
        state: nodeState,
      });
    }
  }

  if (destinations.length === 0) {
    destinations.push(
      ...workflow.destinations.map((destination) => ({
        detail: destination.accountId || 'Account not selected',
        kind: 'destination' as const,
        label: getPlatformMetadata(destination.destinationId).label,
        platform: destination.destinationId,
        state: nodeState,
      })),
    );
  }

  return { destinations, source, stages };
}

function LoadingWorkflows({ announce = true }: { readonly announce?: boolean }) {
  return (
    <Panel
      aria-hidden={announce ? undefined : true}
      aria-live={announce ? 'polite' : undefined}
      className="flex items-center gap-[var(--or-space-3)]"
      role={announce ? 'status' : undefined}
    >
      <Spinner />
      <p className="text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)]">
        Loading workflow routes…
      </p>
    </Panel>
  );
}

export function WorkflowsPage({
  accounts,
  error,
  isLoading,
  metaTargets,
  onApplyPreset,
  onCreateWorkflow,
  onRetry,
  sources,
  presets,
  workflows,
}: WorkflowsPageProps) {
  const [editorDraft, setEditorDraft] = useState<WorkflowEditorValue>();
  const [editorRevision, setEditorRevision] = useState(0);
  const [applyingPreset, setApplyingPreset] = useState<WorkflowPresetView['id']>();
  const [presetNotice, setPresetNotice] = useState<string>();
  const builderRef = useRef<HTMLElement>(null);

  const applyPreset = async (preset: WorkflowPresetView) => {
    setApplyingPreset(preset.id);
    setPresetNotice(undefined);
    try {
      const draft = await onApplyPreset(preset.id);
      setEditorDraft(draft);
      setEditorRevision((current) => current + 1);
      setPresetNotice(`${preset.label} is loaded below. Review every field before saving.`);
      requestAnimationFrame(() =>
        builderRef.current?.querySelector<HTMLInputElement>('input[name="workflow-name"]')?.focus(),
      );
    } catch {
      // The route owns the persistent request error and recovery action.
    } finally {
      setApplyingPreset(undefined);
    }
  };

  return (
    <div aria-busy={isLoading || undefined} className="grid gap-[var(--or-space-8)]">
      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload workflow data
            </Button>
          }
          title="Workflow request failed"
          variant="error"
        >
          {error}
        </Alert>
      )}

      <section aria-labelledby="workflow-presets-heading">
        <header className="mb-[var(--or-space-4)]">
          <p className="font-[family-name:var(--or-font-technical)] font-semibold tracking-[var(--or-type-eyebrow-tracking)] text-[var(--or-text-accent)] uppercase [font-size:var(--or-type-eyebrow-size)] [line-height:var(--or-type-eyebrow-line)]">
            Guided starts
          </p>
          <h2
            className="mt-[var(--or-space-1)] font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id="workflow-presets-heading"
          >
            Streamer presets
          </h2>
          <p className="mt-[var(--or-space-2)] text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
            Start with a capability-checked route, then edit the generated workflow in the normal
            builder before saving.
          </p>
        </header>
        {presetNotice !== undefined && (
          <Alert title="Preset ready" variant="success">
            {presetNotice}
          </Alert>
        )}
        <div className="mt-[var(--or-space-3)] grid gap-[var(--or-space-3)] min-[90rem]:grid-cols-2">
          {presets.map((preset) => (
            <Panel className="flex flex-col gap-[var(--or-space-3)]" key={preset.id}>
              <div className="flex flex-wrap items-start justify-between gap-[var(--or-space-3)]">
                <div className="min-w-0">
                  <h3 className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)]">
                    {preset.label}
                  </h3>
                  <p className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
                    {preset.description}
                  </p>
                </div>
                <Badge
                  variant={
                    preset.status === 'ready'
                      ? 'success'
                      : preset.status === 'partial'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {preset.status === 'ready'
                    ? 'Ready'
                    : preset.status === 'partial'
                      ? 'Partial'
                      : 'Unavailable'}
                </Badge>
              </div>
              <p className="text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)]">
                Destinations:{' '}
                {preset.destinationIds.length === 0
                  ? 'none available'
                  : preset.destinationIds
                      .map((destinationId) => getPlatformMetadata(destinationId).label)
                      .join(', ')}
              </p>
              {preset.issues.map((issue) => (
                <Alert
                  key={`${preset.id}:${issue.code}:${issue.message}`}
                  title={issue.severity === 'blocking' ? 'Requirement missing' : 'Limited route'}
                  variant={issue.severity === 'blocking' ? 'info' : 'warning'}
                >
                  {issue.message}
                </Alert>
              ))}
              <div className="mt-auto">
                <Button
                  disabled={preset.status === 'blocked'}
                  isLoading={applyingPreset === preset.id}
                  onClick={() => void applyPreset(preset)}
                  variant="secondary"
                >
                  Use preset
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      </section>

      <section aria-labelledby="workflow-builder-heading" ref={builderRef}>
        <header className="mb-[var(--or-space-5)]">
          <p className="font-[family-name:var(--or-font-technical)] font-semibold tracking-[var(--or-type-eyebrow-tracking)] text-[var(--or-text-accent)] uppercase [font-size:var(--or-type-eyebrow-size)] [line-height:var(--or-type-eyebrow-line)]">
            Route builder
          </p>
          <h2
            className="mt-[var(--or-space-1)] font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
            id="workflow-builder-heading"
          >
            Create a workflow
          </h2>
          <p className="mt-[var(--or-space-2)] text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
            Build one explicit route from a watched folder or authorized source to one or more
            publish targets. Meta credential identities are not publish targets.
          </p>
        </header>

        {isLoading ? (
          <LoadingWorkflows />
        ) : (
          <WorkflowEditor
            accounts={accounts}
            {...(editorDraft === undefined ? {} : { initialValue: editorDraft })}
            key={editorRevision}
            metaTargets={metaTargets}
            onSubmit={onCreateWorkflow}
            sources={sources}
          />
        )}
      </section>

      <section aria-labelledby="saved-workflows-heading">
        <header className="mb-[var(--or-space-4)] flex flex-wrap items-center justify-between gap-[var(--or-space-3)]">
          <div>
            <h2
              className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id="saved-workflows-heading"
            >
              Saved workflows
            </h2>
            <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              Persisted routes compiled and validated by the application core.
            </p>
          </div>
          {!isLoading && (
            <Badge variant="neutral">
              {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
            </Badge>
          )}
        </header>

        {isLoading ? (
          <LoadingWorkflows announce={false} />
        ) : workflows.length === 0 ? (
          <ResourceEmptyState
            description="Create a route from a source through any processing stages to one or more destinations."
            title="No saved workflows"
          />
        ) : (
          <div className="grid gap-[var(--or-space-3)]">
            {workflows.map((workflow) => {
              const route = toWorkflowRouteData(workflow);

              return (
                <WorkflowCard
                  destinations={route.destinations}
                  enabled={workflow.enabled}
                  key={workflow.id}
                  name={workflow.name}
                  source={route.source}
                  sourceLabel={
                    workflow.sourceDirectory.trim() ||
                    workflow.remoteSource?.connectionId.trim() ||
                    'Remote source'
                  }
                  stages={route.stages ?? []}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

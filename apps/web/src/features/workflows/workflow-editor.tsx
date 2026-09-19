import { useMemo, useRef, useState } from 'react';

import { WorkflowRoute } from '../../components/patterns';
import {
  Alert,
  Button,
  Checkbox,
  FormField,
  Input,
  Panel,
  Select,
  Textarea,
} from '../../components/ui';

export type WorkflowDefinitionView = {
  schemaVersion: 1;
  steps: readonly WorkflowStepView[];
  edges: readonly { from: string; to: string }[];
};

type WorkflowStepView =
  | { id: string; kind: 'source'; sourceType: 'remote' | 'watched_folder' }
  | { id: string; kind: 'filter'; filters: Record<string, unknown> }
  | { id: string; kind: 'transform'; operation: 'pass_through' }
  | { id: string; kind: 'schedule'; scheduleId: string }
  | { id: string; kind: 'destination'; destination: WorkflowDestinationView };

export type WorkflowDestinationView = {
  accountId: string;
  destinationId: 'youtube' | 'tiktok' | 'instagram' | 'facebook';
  privacy?: 'private' | 'public' | 'unlisted';
  privacyLevel?: string;
};

export type WorkflowEditorValue = {
  name: string;
  sourceDirectory?: string;
  remoteSource?: {
    connectionId: string;
    filters?: Record<string, unknown>;
    retentionPolicy?: { kind: string; durationSeconds?: number };
    rightsConfirmed: boolean;
  };
  titleTemplate: string;
  descriptionTemplate: string;
  destinations: readonly WorkflowDestinationView[];
  definition: WorkflowDefinitionView;
  enabled: boolean;
};

type AccountOption = { id: string; displayName: string; provider: string; status: string };
type TargetOption = {
  id: string;
  displayName: string;
  kind: string;
  enabled: boolean;
  availability: string;
};
type SourceOption = { id: string; displayName: string; status: string };

function RouteStepHeader({
  description,
  label,
  marker,
}: {
  readonly description: string;
  readonly label: string;
  readonly marker: string;
}) {
  return (
    <div className="flex gap-[var(--or-space-3)]">
      <span
        aria-hidden="true"
        className="grid size-[var(--or-control-compact-height)] shrink-0 place-items-center rounded-[var(--or-radius-round)] border border-[var(--or-route-selected)] bg-[var(--or-bg-selected)] font-[family-name:var(--or-font-technical)] text-[var(--or-route-selected)] [font-size:var(--or-type-metadata-size)]"
      >
        {marker}
      </span>
      <div className="min-w-0">
        <h3 className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
          {label}
        </h3>
        <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
          {description}
        </p>
      </div>
    </div>
  );
}

export function WorkflowEditor({
  accounts,
  metaTargets,
  sources,
  onSubmit,
}: {
  accounts: readonly AccountOption[];
  metaTargets: readonly TargetOption[];
  sources: readonly SourceOption[];
  onSubmit: (value: WorkflowEditorValue) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [sourceDirectory, setSourceDirectory] = useState('');
  const [remoteSourceId, setRemoteSourceId] = useState('');
  const [retention, setRetention] = useState('delete_after_success');
  const [retentionHours, setRetentionHours] = useState('24');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [titleTemplate, setTitleTemplate] = useState('{{file.stem}}');
  const [descriptionTemplate, setDescriptionTemplate] = useState('');
  const [filterTitle, setFilterTitle] = useState('');
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [transformEnabled, setTransformEnabled] = useState(false);
  const [scheduleId, setScheduleId] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [destinations, setDestinations] = useState<WorkflowDestinationView[]>([]);
  const [validationError, setValidationError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const validationRef = useRef<HTMLDivElement>(null);

  const targetOptions = useMemo(
    () => [
      ...accounts
        .filter((account) => account.status === 'connected')
        .map((account) => ({
          value: `${account.provider}:${account.id}`,
          label: `${account.displayName} · ${account.provider}`,
          disabled: false,
        })),
      ...metaTargets.map((target) => ({
        value: `${target.kind === 'instagram_professional' ? 'instagram' : 'facebook'}:${target.id}`,
        label: `${target.displayName} · ${target.kind === 'instagram_professional' ? 'Instagram' : 'Facebook Page'}`,
        disabled: target.availability !== 'available' || !target.enabled,
      })),
    ],
    [accounts, metaTargets],
  );

  const addDestination = () =>
    setDestinations((current) => [
      ...current,
      { destinationId: 'youtube', accountId: '', privacy: 'private' },
    ]);
  const updateDestination = (index: number, value: string) => {
    const [destinationId, accountId = ''] = value.split(':', 2) as [
      WorkflowDestinationView['destinationId'],
      string?,
    ];
    setDestinations((current) =>
      current.map((destination, position) =>
        position === index
          ? destinationId === 'youtube'
            ? { destinationId, accountId, privacy: 'private' }
            : destinationId === 'tiktok'
              ? { destinationId, accountId, privacyLevel: 'SELF_ONLY' }
              : { destinationId, accountId }
          : destination,
      ),
    );
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(undefined);
    const reportValidationError = (message: string) => {
      setValidationError(message);
      requestAnimationFrame(() => validationRef.current?.focus());
    };
    if (name.trim().length === 0) return reportValidationError('Give this workflow a name.');
    if (remoteSourceId.length === 0 && sourceDirectory.trim().length === 0) {
      return reportValidationError('Choose a watched folder or a remote source.');
    }
    if (
      destinations.length === 0 ||
      destinations.some((destination) => destination.accountId.trim().length === 0)
    ) {
      return reportValidationError('Add at least one complete destination.');
    }
    if (scheduleEnabled && scheduleId.trim().length === 0) {
      return reportValidationError('Enter the schedule ID for the schedule step.');
    }
    const sourceType =
      remoteSourceId.length === 0 ? ('watched_folder' as const) : ('remote' as const);
    const filter =
      remoteSourceId.length > 0 && filterEnabled && filterTitle.trim().length > 0
        ? { id: 'filter', kind: 'filter' as const, filters: { titleContains: filterTitle.trim() } }
        : undefined;
    const schedule = scheduleEnabled
      ? { id: 'schedule', kind: 'schedule' as const, scheduleId: scheduleId.trim() }
      : undefined;
    const steps: WorkflowStepView[] = [
      { id: 'source', kind: 'source', sourceType },
      ...(filter === undefined ? [] : [filter]),
      ...(transformEnabled
        ? [{ id: 'transform', kind: 'transform' as const, operation: 'pass_through' as const }]
        : []),
      ...(schedule === undefined ? [] : [schedule]),
      ...destinations.map((destination, index) => ({
        id: `destination-${index + 1}`,
        kind: 'destination' as const,
        destination,
      })),
    ];
    const chain = [
      'source',
      ...(filter === undefined ? [] : ['filter']),
      ...(transformEnabled ? ['transform'] : []),
      ...(schedule === undefined ? [] : ['schedule']),
    ];
    const edges = [
      ...chain.slice(0, -1).map((from, index) => ({ from, to: chain[index + 1]! })),
      ...destinations.map((_, index) => ({
        from: chain[chain.length - 1]!,
        to: `destination-${index + 1}`,
      })),
    ];
    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        ...(remoteSourceId.length === 0
          ? { sourceDirectory: sourceDirectory.trim() }
          : {
              remoteSource: {
                connectionId: remoteSourceId,
                retentionPolicy: {
                  kind: retention,
                  ...(retention === 'keep_for_duration'
                    ? { durationSeconds: Number(retentionHours) * 3600 }
                    : {}),
                },
                rightsConfirmed,
                ...(filter === undefined ? {} : { filters: filter.filters }),
              },
            }),
        titleTemplate,
        descriptionTemplate,
        destinations,
        definition: { schemaVersion: 1, steps, edges },
        enabled: true,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="grid gap-[var(--or-field-group-gap-setup)]" onSubmit={submit}>
      {validationError !== undefined && (
        <div ref={validationRef} tabIndex={-1}>
          <Alert title="Workflow needs attention" variant="error">
            {validationError}
          </Alert>
        </div>
      )}
      <FormField label="Workflow name" required>
        <Input
          autoComplete="off"
          name="workflow-name"
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </FormField>
      <Panel className="grid gap-[var(--or-space-3)]">
        <RouteStepHeader
          description="Start with local files or an authorized source connection."
          label="Source"
          marker="01"
        />
        <FormField label="Source type">
          <Select
            name="workflow-source-type"
            value={remoteSourceId}
            onChange={(event) => setRemoteSourceId(event.target.value)}
          >
            <option value="">Watched folder</option>
            {sources
              .filter((source) => source.status === 'active')
              .map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
          </Select>
        </FormField>
        {remoteSourceId.length === 0 ? (
          <FormField label="Watched folder" required>
            <Input
              autoComplete="off"
              name="workflow-source-directory"
              onChange={(event) => setSourceDirectory(event.target.value)}
              placeholder="C:\\Media\\watched"
              spellCheck={false}
              value={sourceDirectory}
            />
          </FormField>
        ) : (
          <>
            <FormField label="Source retention">
              <Select
                name="workflow-source-retention"
                value={retention}
                onChange={(event) => setRetention(event.target.value)}
              >
                <option value="delete_after_success">Delete after destinations succeed</option>
                <option value="keep_for_duration">Keep for a duration</option>
                <option value="keep_forever">Keep forever</option>
              </Select>
            </FormField>
            {retention === 'keep_for_duration' && (
              <FormField label="Retention hours" required>
                <Input
                  min="1"
                  name="workflow-retention-hours"
                  type="number"
                  value={retentionHours}
                  onChange={(event) => setRetentionHours(event.target.value)}
                />
              </FormField>
            )}
            <Checkbox
              checked={rightsConfirmed}
              label="I own this source media or am authorized to reuse it."
              onChange={(event) => setRightsConfirmed(event.target.checked)}
            />
          </>
        )}
      </Panel>
      <details className="group rounded-[var(--or-setup-section-radius)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-surface)]">
        <summary className="flex min-h-[var(--or-control-default-height)] cursor-pointer list-none items-center justify-between gap-[var(--or-space-3)] rounded-[var(--or-setup-section-radius)] px-[var(--or-pane-padding)] py-[var(--or-space-3)] text-[var(--or-text-primary)] focus-visible:outline-[var(--or-focus-width)] focus-visible:outline-offset-[var(--or-focus-offset)] focus-visible:[outline-color:var(--or-focus-ring)]">
          <span>
            <span className="block font-semibold [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
              Optional route stages
            </span>
            <span className="mt-[var(--or-space-1)] block text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
              Filter, transform, or pause the route at an existing schedule boundary.
            </span>
          </span>
          <span
            aria-hidden="true"
            className="text-[var(--or-route-selected)] transition-transform duration-[var(--or-duration-fast)] group-open:rotate-45 motion-reduce:transition-none"
          >
            +
          </span>
        </summary>
        <div className="grid gap-[var(--or-space-5)] border-t border-[var(--or-border-subtle)] p-[var(--or-pane-padding)]">
          <section
            className="grid gap-[var(--or-space-3)]"
            aria-labelledby="workflow-filter-heading"
          >
            <div>
              <h3
                className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]"
                id="workflow-filter-heading"
              >
                Title filter
              </h3>
              <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
                Only remote sources can use a title filter in v0.5.
              </p>
            </div>
            <Checkbox
              checked={filterEnabled}
              disabled={remoteSourceId.length === 0}
              label="Enable title filter"
              onChange={(event) => setFilterEnabled(event.target.checked)}
            />
            {filterEnabled && remoteSourceId.length > 0 && (
              <FormField label="Title contains">
                <Input
                  autoComplete="off"
                  name="workflow-title-filter"
                  onChange={(event) => setFilterTitle(event.target.value)}
                  placeholder="Text to match"
                  value={filterTitle}
                />
              </FormField>
            )}
          </section>
          <section
            aria-labelledby="workflow-transform-heading"
            className="grid gap-[var(--or-space-3)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-5)]"
          >
            <div>
              <h3
                className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]"
                id="workflow-transform-heading"
              >
                Pass-through transform
              </h3>
              <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
                v0.5 stores a pass-through transform boundary; media operations arrive in v0.6.
              </p>
            </div>
            <Checkbox
              checked={transformEnabled}
              label="Include pass-through transform step"
              onChange={(event) => setTransformEnabled(event.target.checked)}
            />
          </section>
          <section
            aria-labelledby="workflow-schedule-heading"
            className="grid gap-[var(--or-space-3)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-5)]"
          >
            <div>
              <h3
                className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]"
                id="workflow-schedule-heading"
              >
                Schedule boundary
              </h3>
              <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
                Attach an existing durable schedule by ID. Timing and timezone remain owned by the
                scheduler.
              </p>
            </div>
            <Checkbox
              checked={scheduleEnabled}
              label="Hold this workflow at a schedule boundary"
              onChange={(event) => setScheduleEnabled(event.target.checked)}
            />
            {scheduleEnabled && (
              <FormField label="Schedule ID" required>
                <Input
                  autoComplete="off"
                  name="workflow-schedule-id"
                  onChange={(event) => setScheduleId(event.target.value)}
                  value={scheduleId}
                />
              </FormField>
            )}
          </section>
        </div>
      </details>
      <Panel className="grid gap-[var(--or-space-3)]">
        <RouteStepHeader
          description="Choose exact publish targets. Unavailable Meta targets remain visible instead of being silently replaced."
          label="Destinations"
          marker="02"
        />
        {destinations.map((destination, index) => (
          <div className="flex flex-col gap-[var(--or-space-2)] sm:flex-row" key={index}>
            <Select
              aria-label={`Destination ${index + 1}`}
              className="min-w-0 flex-1"
              name={`workflow-destination-${index + 1}`}
              value={`${destination.destinationId}:${destination.accountId}`}
              onChange={(event) => updateDestination(index, event.target.value)}
            >
              <option value="">Select a publish target</option>
              {targetOptions.map((option) => (
                <option disabled={option.disabled} key={option.value} value={option.value}>
                  {option.label}
                  {option.disabled ? ' · unavailable' : ''}
                </option>
              ))}
            </Select>
            <Button
              onClick={() =>
                setDestinations((current) => current.filter((_, position) => position !== index))
              }
              size="sm"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
        ))}
        <Button className="w-fit" onClick={addDestination}>
          Add destination
        </Button>
      </Panel>
      <Panel className="grid gap-[var(--or-space-3)]" surface="inset">
        <div>
          <h3 className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
            Metadata templates
          </h3>
          <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
            Apply the same title and description rules to every destination in this route.
          </p>
        </div>
        <FormField label="Title template" required>
          <Input
            autoComplete="off"
            name="workflow-title-template"
            onChange={(event) => setTitleTemplate(event.target.value)}
            spellCheck={false}
            value={titleTemplate}
          />
        </FormField>
        <FormField label="Description template">
          <Textarea
            name="workflow-description-template"
            onChange={(event) => setDescriptionTemplate(event.target.value)}
            value={descriptionTemplate}
          />
        </FormField>
      </Panel>
      <Panel>
        <div>
          <h3 className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
            Route preview
          </h3>
          <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
            Review the source, processing stages, and destinations before saving.
          </p>
        </div>
        <div className="mt-[var(--or-space-3)]">
          <WorkflowRoute
            destinations={destinations.map((destination, index) => ({
              kind: 'destination',
              label:
                targetOptions.find(
                  (option) =>
                    option.value === `${destination.destinationId}:${destination.accountId}`,
                )?.label ?? `Destination ${index + 1}`,
              platform: destination.destinationId,
            }))}
            source={{
              detail:
                remoteSourceId.length === 0
                  ? sourceDirectory || 'Folder not selected'
                  : 'Remote source',
              kind: 'source',
              label:
                remoteSourceId.length === 0
                  ? 'Watched folder'
                  : (sources.find((source) => source.id === remoteSourceId)?.displayName ??
                    'Remote source'),
              ...(remoteSourceId.length === 0 ? { platform: 'local' } : {}),
            }}
            stages={[
              ...(remoteSourceId.length > 0 && filterEnabled
                ? [
                    {
                      detail: filterTitle || 'Title rule not configured',
                      kind: 'filter' as const,
                      label: 'Title filter',
                    },
                  ]
                : []),
              ...(transformEnabled ? [{ kind: 'transform' as const, label: 'Pass-through' }] : []),
              ...(scheduleEnabled
                ? [
                    {
                      detail: scheduleId || 'Schedule not selected',
                      kind: 'schedule' as const,
                      label: 'Schedule boundary',
                    },
                  ]
                : []),
            ]}
          />
        </div>
        <p className="mt-[var(--or-space-3)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
          The saved definition is compiled and validated by the application core before persistence.
        </p>
      </Panel>
      <div className="flex flex-col gap-[var(--or-space-3)] sm:flex-row sm:items-center">
        <Button
          isLoading={isSubmitting}
          loadingLabel="Saving workflow…"
          type="submit"
          variant="primary"
        >
          Save workflow
        </Button>
        <span className="text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
          Invalid or disconnected graphs are rejected by the core.
        </span>
      </div>
    </form>
  );
}

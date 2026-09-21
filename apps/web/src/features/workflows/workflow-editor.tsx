import { useMemo, useRef, useState } from 'react';

import { WorkflowRoute, getPlatformMetadata } from '../../components/patterns';
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
  | {
      id: string;
      kind: 'source';
      sourceType: 'remote' | 'watched_folder';
      watchedFolder?: WatchedFolderSettingsView;
    }
  | { id: string; kind: 'filter'; filters: Record<string, unknown> }
  | {
      id: string;
      kind: 'transform';
      operation?: 'pass_through';
      plan?: TransformPlanView;
    }
  | { id: string; kind: 'schedule'; scheduleId: string }
  | { id: string; kind: 'destination'; destination: WorkflowDestinationView };

type TransformFitMode = 'contain' | 'crop' | 'stretch';
type TransformAnchor = 'bottom' | 'center' | 'left' | 'right' | 'top';
type TransformPreset = 'custom' | 'landscape' | 'square' | 'vertical';
type WatchedFolderPreset = 'standard' | 'obs_recording' | 'obs_replay_buffer';

type WatchedFolderSettingsView = {
  filenameMetadata: 'file_stem' | 'obs';
  preset: WatchedFolderPreset;
  settleMs: number;
  sidecarMetadata: boolean;
};

type TransformPlanView = {
  schemaVersion: 1;
  user: {
    schemaVersion: 1;
    steps: readonly [
      | {
          type: 'fit';
          mode: 'stretch';
          width: number;
          height: number;
        }
      | {
          type: 'fit';
          mode: 'contain' | 'crop';
          width: number;
          height: number;
          anchor: TransformAnchor;
        },
    ];
    output: Record<string, never>;
  };
};

const transformPresets: Readonly<
  Record<Exclude<TransformPreset, 'custom'>, { label: string; width: number; height: number }>
> = {
  vertical: { label: 'Vertical 9:16', width: 1080, height: 1920 },
  square: { label: 'Square 1:1', width: 1080, height: 1080 },
  landscape: { label: 'Landscape 16:9', width: 1920, height: 1080 },
};

const watchedFolderPresets: Readonly<
  Record<
    WatchedFolderPreset,
    {
      description: string;
      label: string;
      settings?: WatchedFolderSettingsView;
    }
  >
> = {
  standard: {
    label: 'Standard watched folder',
    description: 'Use the installation-wide settle window and the original file name.',
  },
  obs_recording: {
    label: 'OBS recording folder',
    description: 'Wait 10 seconds after the file stops changing before import.',
    settings: {
      filenameMetadata: 'obs',
      preset: 'obs_recording',
      settleMs: 10_000,
      sidecarMetadata: true,
    },
  },
  obs_replay_buffer: {
    label: 'OBS Replay Buffer folder',
    description: 'Wait 5 seconds after the completed replay file appears before import.',
    settings: {
      filenameMetadata: 'obs',
      preset: 'obs_replay_buffer',
      settleMs: 5_000,
      sidecarMetadata: true,
    },
  },
};

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
type ValidationField =
  'destinations' | 'name' | 'retention' | 'schedule' | 'source' | 'titleTemplate' | 'transform';
type ValidationError = { readonly field: ValidationField; readonly message: string };

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
  const [watchedFolderPreset, setWatchedFolderPreset] = useState<WatchedFolderPreset>('standard');
  const [remoteSourceId, setRemoteSourceId] = useState('');
  const [retention, setRetention] = useState('delete_after_success');
  const [retentionHours, setRetentionHours] = useState('24');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [titleTemplate, setTitleTemplate] = useState('{{file.stem}}');
  const [descriptionTemplate, setDescriptionTemplate] = useState('');
  const [filterTitle, setFilterTitle] = useState('');
  const [filterEnabled, setFilterEnabled] = useState(false);
  const [transformEnabled, setTransformEnabled] = useState(false);
  const [transformPreset, setTransformPreset] = useState<TransformPreset>('vertical');
  const [transformWidth, setTransformWidth] = useState('1080');
  const [transformHeight, setTransformHeight] = useState('1920');
  const [transformFit, setTransformFit] = useState<TransformFitMode>('crop');
  const [transformAnchor, setTransformAnchor] = useState<TransformAnchor>('center');
  const [scheduleId, setScheduleId] = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [destinations, setDestinations] = useState<WorkflowDestinationView[]>([]);
  const [validationError, setValidationError] = useState<ValidationError>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const sourceDirectoryRef = useRef<HTMLInputElement>(null);
  const retentionHoursRef = useRef<HTMLInputElement>(null);
  const scheduleIdRef = useRef<HTMLInputElement>(null);
  const titleTemplateRef = useRef<HTMLInputElement>(null);
  const transformWidthRef = useRef<HTMLInputElement>(null);
  const addDestinationRef = useRef<HTMLButtonElement>(null);
  const optionalStagesRef = useRef<HTMLDetailsElement>(null);
  const transformAdvancedRef = useRef<HTMLDetailsElement>(null);

  const clearValidationError = (field: ValidationField) => {
    setValidationError((current) => (current?.field === field ? undefined : current));
  };

  const targetOptions = useMemo(
    () => [
      ...accounts
        .filter((account) => account.status === 'connected')
        .map((account) => ({
          value: `${account.provider}:${account.id}`,
          label: `${account.displayName.trim() || 'Unnamed account'} · ${getPlatformMetadata(account.provider).label}`,
          disabled: false,
        })),
      ...metaTargets.map((target) => ({
        value: `${target.kind === 'instagram_professional' ? 'instagram' : 'facebook'}:${target.id}`,
        label: `${target.displayName.trim() || 'Unnamed target'} · ${target.kind === 'instagram_professional' ? 'Instagram' : 'Facebook Page'}`,
        disabled: target.availability !== 'available' || !target.enabled,
      })),
    ],
    [accounts, metaTargets],
  );
  const selectedTransformDimensions =
    transformPreset === 'custom'
      ? { width: transformWidth || '?', height: transformHeight || '?' }
      : transformPresets[transformPreset];

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
    clearValidationError('destinations');
  };
  const removeDestination = (index: number) => {
    setDestinations((current) => current.filter((_, position) => position !== index));
    clearValidationError('destinations');
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(undefined);
    const reportValidationError = (field: ValidationField, message: string) => {
      setValidationError({ field, message });
      if (field === 'retention' || field === 'schedule' || field === 'transform') {
        optionalStagesRef.current?.setAttribute('open', '');
      }
      if (field === 'transform') transformAdvancedRef.current?.setAttribute('open', '');
      requestAnimationFrame(() => {
        if (field === 'name') nameRef.current?.focus();
        if (field === 'source') sourceDirectoryRef.current?.focus();
        if (field === 'retention') retentionHoursRef.current?.focus();
        if (field === 'schedule') scheduleIdRef.current?.focus();
        if (field === 'titleTemplate') titleTemplateRef.current?.focus();
        if (field === 'transform') transformWidthRef.current?.focus();
        if (field === 'destinations') {
          const firstIncompleteDestination = formRef.current?.querySelector<HTMLSelectElement>(
            'select[name^="workflow-destination-"]:invalid',
          );
          (firstIncompleteDestination ?? addDestinationRef.current)?.focus();
        }
      });
    };
    if (name.trim().length === 0) {
      return reportValidationError('name', 'Give this workflow a name.');
    }
    if (remoteSourceId.length === 0 && sourceDirectory.trim().length === 0) {
      return reportValidationError('source', 'Choose a watched folder or a remote source.');
    }
    if (
      remoteSourceId.length > 0 &&
      retention === 'keep_for_duration' &&
      (!Number.isFinite(Number(retentionHours)) || Number(retentionHours) < 1)
    ) {
      return reportValidationError('retention', 'Enter a retention duration of at least one hour.');
    }
    if (
      destinations.length === 0 ||
      destinations.some((destination) => destination.accountId.trim().length === 0)
    ) {
      return reportValidationError('destinations', 'Add at least one complete destination.');
    }
    const destinationKeys = destinations.map(
      (destination) => `${destination.destinationId}:${destination.accountId}`,
    );
    if (new Set(destinationKeys).size !== destinationKeys.length) {
      return reportValidationError('destinations', 'Choose each destination only once.');
    }
    if (scheduleEnabled && scheduleId.trim().length === 0) {
      return reportValidationError('schedule', 'Enter the schedule ID for the schedule step.');
    }
    if (titleTemplate.trim().length === 0) {
      return reportValidationError('titleTemplate', 'Enter a title template.');
    }
    const presetDimensions =
      transformPreset === 'custom' ? undefined : transformPresets[transformPreset];
    const transformTargetWidth = presetDimensions?.width ?? Number(transformWidth);
    const transformTargetHeight = presetDimensions?.height ?? Number(transformHeight);
    if (
      transformEnabled &&
      (!Number.isInteger(transformTargetWidth) ||
        !Number.isInteger(transformTargetHeight) ||
        transformTargetWidth < 2 ||
        transformTargetHeight < 2 ||
        transformTargetWidth > 16_384 ||
        transformTargetHeight > 16_384 ||
        transformTargetWidth % 2 !== 0 ||
        transformTargetHeight % 2 !== 0)
    ) {
      return reportValidationError(
        'transform',
        'Width and height must be even whole numbers from 2 to 16384 pixels.',
      );
    }
    const transformPlan: TransformPlanView = {
      schemaVersion: 1,
      user: {
        schemaVersion: 1,
        steps: [
          transformFit === 'stretch'
            ? {
                type: 'fit',
                mode: 'stretch',
                width: transformTargetWidth,
                height: transformTargetHeight,
              }
            : {
                type: 'fit',
                mode: transformFit,
                width: transformTargetWidth,
                height: transformTargetHeight,
                anchor: transformAnchor,
              },
        ],
        output: {},
      },
    };
    const sourceType =
      remoteSourceId.length === 0 ? ('watched_folder' as const) : ('remote' as const);
    const filter =
      remoteSourceId.length > 0 && filterEnabled && filterTitle.trim().length > 0
        ? { id: 'filter', kind: 'filter' as const, filters: { titleContains: filterTitle.trim() } }
        : undefined;
    const schedule = scheduleEnabled
      ? { id: 'schedule', kind: 'schedule' as const, scheduleId: scheduleId.trim() }
      : undefined;
    const watchedFolderSettings = watchedFolderPresets[watchedFolderPreset].settings;
    const steps: WorkflowStepView[] = [
      {
        id: 'source',
        kind: 'source',
        sourceType,
        ...(sourceType === 'watched_folder' && watchedFolderSettings !== undefined
          ? { watchedFolder: watchedFolderSettings }
          : {}),
      },
      ...(filter === undefined ? [] : [filter]),
      ...(transformEnabled
        ? [{ id: 'transform', kind: 'transform' as const, plan: transformPlan }]
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
    <form
      className="grid gap-[var(--or-field-group-gap-setup)]"
      noValidate
      onSubmit={submit}
      ref={formRef}
    >
      {validationError !== undefined && (
        <Alert title="Workflow needs attention" variant="error">
          {validationError.message}
        </Alert>
      )}
      <FormField
        {...(validationError?.field === 'name' ? { error: validationError.message } : {})}
        label="Workflow name"
        required
      >
        <Input
          autoComplete="off"
          disabled={isSubmitting}
          name="workflow-name"
          onChange={(event) => {
            setName(event.target.value);
            clearValidationError('name');
          }}
          ref={nameRef}
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
            disabled={isSubmitting}
            name="workflow-source-type"
            value={remoteSourceId}
            onChange={(event) => {
              setRemoteSourceId(event.target.value);
              clearValidationError('source');
              clearValidationError('retention');
            }}
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
          <>
            <FormField
              description={watchedFolderPresets[watchedFolderPreset].description}
              label="Folder preset"
            >
              <Select
                disabled={isSubmitting}
                name="workflow-watched-folder-preset"
                onChange={(event) => {
                  const preset = event.target.value as WatchedFolderPreset;
                  setWatchedFolderPreset(preset);
                  if (preset === 'standard' && titleTemplate === '{{source.title}}')
                    setTitleTemplate('{{file.stem}}');
                  if (preset !== 'standard' && titleTemplate === '{{file.stem}}')
                    setTitleTemplate('{{source.title}}');
                }}
                value={watchedFolderPreset}
              >
                {Object.entries(watchedFolderPresets).map(([value, preset]) => (
                  <option key={value} value={value}>
                    {preset.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              {...(validationError?.field === 'source' ? { error: validationError.message } : {})}
              description={
                watchedFolderPreset === 'standard'
                  ? 'Use an absolute Windows or Linux path accessible to this OpenRepurpose installation.'
                  : 'Use the same absolute path configured in OBS. OpenRepurpose scans it locally. No OBS plugin is required.'
              }
              label="Watched folder"
              required
            >
              <Input
                autoComplete="off"
                disabled={isSubmitting}
                name="workflow-source-directory"
                onChange={(event) => {
                  setSourceDirectory(event.target.value);
                  clearValidationError('source');
                }}
                placeholder="C:\\Media\\watched"
                spellCheck={false}
                ref={sourceDirectoryRef}
                value={sourceDirectory}
              />
            </FormField>
            {watchedFolderPreset !== 'standard' && (
              <Alert title="OBS folder setup" variant="info">
                Choose this path in OBS under Settings → Output → Recording. Files may grow or be
                renamed while OBS finalizes them; OpenRepurpose waits for the selected settle window
                and imports each completed file once. Common OBS timestamps are parsed, and an
                optional same-name JSON sidecar can supply title, description, publishedAt, and
                externalId metadata.
              </Alert>
            )}
          </>
        ) : (
          <>
            <FormField label="Source retention">
              <Select
                disabled={isSubmitting}
                name="workflow-source-retention"
                value={retention}
                onChange={(event) => {
                  setRetention(event.target.value);
                  clearValidationError('retention');
                }}
              >
                <option value="delete_after_success">Delete after destinations succeed</option>
                <option value="keep_for_duration">Keep for a duration</option>
                <option value="keep_forever">Keep forever</option>
              </Select>
            </FormField>
            {retention === 'keep_for_duration' && (
              <FormField
                {...(validationError?.field === 'retention'
                  ? { error: validationError.message }
                  : {})}
                label="Retention hours"
                required
              >
                <Input
                  disabled={isSubmitting}
                  min="1"
                  name="workflow-retention-hours"
                  type="number"
                  value={retentionHours}
                  onChange={(event) => {
                    setRetentionHours(event.target.value);
                    clearValidationError('retention');
                  }}
                  ref={retentionHoursRef}
                />
              </FormField>
            )}
            <Checkbox
              checked={rightsConfirmed}
              disabled={isSubmitting}
              label="I own this source media or am authorized to reuse it."
              onChange={(event) => setRightsConfirmed(event.target.checked)}
            />
          </>
        )}
      </Panel>
      <details
        className="group rounded-[var(--or-setup-section-radius)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-surface)]"
        ref={optionalStagesRef}
      >
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
              disabled={isSubmitting || remoteSourceId.length === 0}
              label="Enable title filter"
              onChange={(event) => setFilterEnabled(event.target.checked)}
            />
            {filterEnabled && remoteSourceId.length > 0 && (
              <FormField label="Title contains">
                <Input
                  autoComplete="off"
                  disabled={isSubmitting}
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
                Media transform
              </h3>
              <p className="mt-[var(--or-space-1)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
                Prepare one reusable local derivative before destination jobs fan out.
              </p>
            </div>
            <Checkbox
              checked={transformEnabled}
              disabled={isSubmitting}
              label="Transform media for destinations"
              onChange={(event) => {
                setTransformEnabled(event.target.checked);
                if (!event.target.checked) clearValidationError('transform');
              }}
            />
            {transformEnabled && (
              <div className="grid gap-[var(--or-space-3)]">
                <FormField label="Output preset">
                  <Select
                    disabled={isSubmitting}
                    name="workflow-transform-preset"
                    onChange={(event) => {
                      const preset = event.target.value as TransformPreset;
                      setTransformPreset(preset);
                      clearValidationError('transform');
                      if (preset === 'custom') {
                        transformAdvancedRef.current?.setAttribute('open', '');
                        requestAnimationFrame(() => transformWidthRef.current?.focus());
                      } else {
                        setTransformWidth(String(transformPresets[preset].width));
                        setTransformHeight(String(transformPresets[preset].height));
                      }
                    }}
                    value={transformPreset}
                  >
                    <option value="vertical">Vertical 9:16 · 1080 × 1920</option>
                    <option value="square">Square 1:1 · 1080 × 1080</option>
                    <option value="landscape">Landscape 16:9 · 1920 × 1080</option>
                    <option value="custom">Custom dimensions</option>
                  </Select>
                </FormField>
                <details
                  className="group rounded-[var(--or-radius-md)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-workspace)]"
                  ref={transformAdvancedRef}
                >
                  <summary className="flex min-h-[var(--or-control-default-height)] cursor-pointer list-none items-center justify-between gap-[var(--or-space-3)] rounded-[var(--or-radius-md)] px-[var(--or-space-3)] text-[var(--or-text-secondary)] focus-visible:outline-[var(--or-focus-width)] focus-visible:outline-offset-[var(--or-focus-offset)] focus-visible:[outline-color:var(--or-focus-ring)] [font-size:var(--or-type-interface-size)]">
                    <span>Advanced transform controls</span>
                    <span
                      aria-hidden="true"
                      className="text-[var(--or-text-accent)] transition-transform duration-[var(--or-duration-fast)] group-open:rotate-45 motion-reduce:transition-none"
                    >
                      +
                    </span>
                  </summary>
                  <div className="grid gap-[var(--or-space-3)] border-t border-[var(--or-border-subtle)] p-[var(--or-space-3)] sm:grid-cols-2">
                    {transformPreset === 'custom' && (
                      <>
                        <FormField
                          {...(validationError?.field === 'transform'
                            ? { error: validationError.message }
                            : {})}
                          label="Width (px)"
                          required
                        >
                          <Input
                            disabled={isSubmitting}
                            id="workflow-transform-width"
                            inputMode="numeric"
                            max="16384"
                            min="2"
                            name="workflow-transform-width"
                            onChange={(event) => {
                              setTransformWidth(event.target.value);
                              clearValidationError('transform');
                            }}
                            ref={transformWidthRef}
                            step="2"
                            type="number"
                            value={transformWidth}
                          />
                        </FormField>
                        <FormField label="Height (px)" required>
                          <Input
                            aria-describedby={
                              validationError?.field === 'transform'
                                ? 'workflow-transform-width-error'
                                : undefined
                            }
                            aria-invalid={validationError?.field === 'transform' || undefined}
                            disabled={isSubmitting}
                            inputMode="numeric"
                            max="16384"
                            min="2"
                            name="workflow-transform-height"
                            onChange={(event) => {
                              setTransformHeight(event.target.value);
                              clearValidationError('transform');
                            }}
                            step="2"
                            type="number"
                            value={transformHeight}
                          />
                        </FormField>
                      </>
                    )}
                    <FormField label="Fit mode">
                      <Select
                        disabled={isSubmitting}
                        name="workflow-transform-fit"
                        onChange={(event) =>
                          setTransformFit(event.target.value as TransformFitMode)
                        }
                        value={transformFit}
                      >
                        <option value="crop">Crop to fill</option>
                        <option value="contain">Contain with padding</option>
                        <option value="stretch">Stretch exactly</option>
                      </Select>
                    </FormField>
                    {transformFit !== 'stretch' && (
                      <FormField label="Frame anchor">
                        <Select
                          disabled={isSubmitting}
                          name="workflow-transform-anchor"
                          onChange={(event) =>
                            setTransformAnchor(event.target.value as TransformAnchor)
                          }
                          value={transformAnchor}
                        >
                          <option value="center">Center</option>
                          <option value="top">Top</option>
                          <option value="bottom">Bottom</option>
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                        </Select>
                      </FormField>
                    )}
                  </div>
                </details>
              </div>
            )}
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
              disabled={isSubmitting}
              label="Hold this workflow at a schedule boundary"
              onChange={(event) => {
                setScheduleEnabled(event.target.checked);
                if (!event.target.checked) clearValidationError('schedule');
              }}
            />
            {scheduleEnabled && (
              <FormField
                {...(validationError?.field === 'schedule'
                  ? { error: validationError.message }
                  : {})}
                label="Schedule ID"
                required
              >
                <Input
                  autoComplete="off"
                  disabled={isSubmitting}
                  name="workflow-schedule-id"
                  onChange={(event) => {
                    setScheduleId(event.target.value);
                    clearValidationError('schedule');
                  }}
                  ref={scheduleIdRef}
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
              aria-describedby={
                validationError?.field === 'destinations' ? 'workflow-destination-error' : undefined
              }
              aria-invalid={
                validationError?.field === 'destinations' &&
                destination.accountId.trim().length === 0
              }
              aria-label={`Destination ${index + 1}`}
              className="min-w-0 flex-1"
              disabled={isSubmitting}
              name={`workflow-destination-${index + 1}`}
              required
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
              disabled={isSubmitting}
              onClick={() => removeDestination(index)}
              size="sm"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
        ))}
        {validationError?.field === 'destinations' && (
          <p
            className="text-[var(--or-status-danger-fg)] [font-size:var(--or-field-help-size)] [line-height:var(--or-field-help-line)]"
            id="workflow-destination-error"
          >
            {validationError.message}
          </p>
        )}
        <Button
          className="w-fit"
          disabled={isSubmitting}
          onClick={addDestination}
          ref={addDestinationRef}
        >
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
        <FormField
          {...(validationError?.field === 'titleTemplate'
            ? { error: validationError.message }
            : {})}
          label="Title template"
          required
        >
          <Input
            autoComplete="off"
            disabled={isSubmitting}
            name="workflow-title-template"
            onChange={(event) => {
              setTitleTemplate(event.target.value);
              clearValidationError('titleTemplate');
            }}
            ref={titleTemplateRef}
            spellCheck={false}
            value={titleTemplate}
          />
        </FormField>
        <FormField label="Description template">
          <Textarea
            disabled={isSubmitting}
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
              ...(transformEnabled
                ? [
                    {
                      detail: `${selectedTransformDimensions.width} × ${selectedTransformDimensions.height} · ${transformFit}`,
                      kind: 'transform' as const,
                      label:
                        transformPreset === 'custom'
                          ? 'Custom output'
                          : transformPresets[transformPreset].label,
                    },
                  ]
                : []),
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

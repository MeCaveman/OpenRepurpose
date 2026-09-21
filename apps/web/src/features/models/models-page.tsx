import { Alert, Badge, Button, Panel, Progress, Spinner } from '../../components/ui';

export interface ModelDownloadView {
  readonly downloadedBytes: number;
  readonly percent?: number;
  readonly totalBytes: number;
}

export interface TranscriptionModelView {
  readonly checksum: { readonly algorithm: string; readonly value: string };
  readonly description: string;
  readonly diskRequiredBytes: number;
  readonly diskWarning: boolean;
  readonly displayName: string;
  readonly error?: string;
  readonly id: string;
  readonly installedAt?: string;
  readonly installedBytes?: number;
  readonly integrity: 'not-installed' | 'unverified' | 'verified' | 'failed';
  readonly languageSupport: 'english' | 'multilingual';
  readonly performance: string;
  readonly progress?: ModelDownloadView;
  readonly sizeBytes: number;
  readonly status: 'not-installed' | 'installed' | 'downloading' | 'failed';
  readonly version: string;
}

export interface ModelManagerView {
  readonly availableBytes?: number;
  readonly models: readonly TranscriptionModelView[];
  readonly reserveBytes: number;
  readonly storagePath: string;
}

export interface ModelsPageProps {
  readonly activeAction: string | undefined;
  readonly error: string | undefined;
  readonly isLoading: boolean;
  readonly manager: ModelManagerView | undefined;
  readonly notice: string | undefined;
  readonly onDelete: (model: TranscriptionModelView) => void;
  readonly onDownload: (modelId: string) => void;
  readonly onRetry: () => void;
  readonly onVerify: (modelId: string) => void;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 'Unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  const amount = value / 1024 ** index;
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: amount >= 10 || index === 0 ? 1 : 2,
  }).format(amount)} ${units[index]}`;
}

function statusBadge(model: TranscriptionModelView) {
  if (model.status === 'downloading') return <Badge variant="info">Downloading</Badge>;
  if (model.status === 'failed') return <Badge variant="error">Needs attention</Badge>;
  if (model.status === 'installed' && model.integrity === 'verified')
    return <Badge variant="success">Installed · verified</Badge>;
  if (model.status === 'installed') return <Badge variant="warning">Installed · unverified</Badge>;
  return <Badge variant="neutral">Not installed</Badge>;
}

function ModelAction({
  activeAction,
  model,
  onDelete,
  onDownload,
  onVerify,
}: Pick<ModelsPageProps, 'activeAction' | 'onDelete' | 'onDownload' | 'onVerify'> & {
  readonly model: TranscriptionModelView;
}) {
  if (model.status === 'downloading')
    return (
      <Button disabled size="sm" variant="secondary">
        Downloading…
      </Button>
    );
  if (model.status !== 'installed')
    return (
      <Button
        disabled={model.diskWarning}
        isLoading={activeAction === `download:${model.id}`}
        loadingLabel="Starting…"
        onClick={() => onDownload(model.id)}
        size="sm"
        variant={model.id === 'base' ? 'primary' : 'secondary'}
      >
        Download model
      </Button>
    );
  return (
    <div className="flex flex-wrap justify-end gap-[var(--or-space-2)]">
      <Button
        isLoading={activeAction === `verify:${model.id}`}
        loadingLabel="Verifying…"
        onClick={() => onVerify(model.id)}
        size="sm"
        variant="secondary"
      >
        Verify checksum
      </Button>
      <Button
        isLoading={activeAction === `delete:${model.id}`}
        loadingLabel="Deleting…"
        onClick={() => onDelete(model)}
        size="sm"
        variant="danger"
      >
        Delete model
      </Button>
    </div>
  );
}

function ModelRow({
  activeAction,
  model,
  onDelete,
  onDownload,
  onVerify,
}: Pick<ModelsPageProps, 'activeAction' | 'onDelete' | 'onDownload' | 'onVerify'> & {
  readonly model: TranscriptionModelView;
}) {
  const progress = model.progress;
  const checksumLabel = `${model.checksum.algorithm.toUpperCase()} ${model.checksum.value}`;

  return (
    <li className="flex flex-col gap-[var(--or-space-4)] px-[var(--or-pane-padding)] py-[var(--or-space-4)] md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[var(--or-space-2)]">
          <h3 className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
            {model.displayName}
          </h3>
          {statusBadge(model)}
          {model.id === 'base' && <Badge variant="accent">Recommended</Badge>}
        </div>
        <p className="mt-[var(--or-space-2)] max-w-[var(--or-measure-prose)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
          {model.description}
        </p>
        <dl className="mt-[var(--or-space-3)] grid grid-cols-2 gap-x-[var(--or-space-5)] gap-y-[var(--or-space-3)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)] sm:flex sm:flex-wrap">
          <div className="grid gap-[var(--or-space-0-5)]">
            <dt className="font-medium">Size</dt>
            <dd className="text-[var(--or-text-secondary)] tabular-nums">
              {formatBytes(model.sizeBytes)}
            </dd>
          </div>
          <div className="grid gap-[var(--or-space-0-5)]">
            <dt className="font-medium">Language</dt>
            <dd className="text-[var(--or-text-secondary)] capitalize">{model.languageSupport}</dd>
          </div>
          <div className="grid gap-[var(--or-space-0-5)]">
            <dt className="font-medium">Runtime</dt>
            <dd className="text-[var(--or-text-secondary)] capitalize">
              {model.performance.replaceAll('-', ' ')}
            </dd>
          </div>
          <div className="col-span-2 grid min-w-0 gap-[var(--or-space-0-5)]">
            <dt className="font-medium">Model ID</dt>
            <dd
              className="break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-secondary)]"
              title={checksumLabel}
              translate="no"
            >
              {model.id}@{model.version}
            </dd>
          </div>
        </dl>
        {progress !== undefined && (
          <div aria-live="polite" className="mt-[var(--or-space-4)] grid gap-[var(--or-space-2)]">
            <div className="flex flex-wrap justify-between gap-[var(--or-space-2)] text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)]">
              <span>Downloading model bytes</span>
              <span className="font-[family-name:var(--or-font-technical)] tabular-nums">
                {formatBytes(progress.downloadedBytes)} / {formatBytes(progress.totalBytes)}
              </span>
            </div>
            <Progress
              aria-label={`${model.displayName} download progress`}
              {...(progress.percent === undefined ? {} : { value: progress.percent })}
            />
          </div>
        )}
        {model.diskWarning && model.status !== 'installed' && (
          <p className="mt-[var(--or-space-3)] text-[var(--or-status-warning-fg)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
            Free additional disk space before downloading. This model and the safety reserve need{' '}
            {formatBytes(model.diskRequiredBytes)}.
          </p>
        )}
        {model.error !== undefined && (
          <p className="mt-[var(--or-space-3)] text-[var(--or-status-danger-fg)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-body-line)]">
            {model.error}
          </p>
        )}
      </div>
      <div className="shrink-0 md:self-center">
        <ModelAction
          activeAction={activeAction}
          model={model}
          onDelete={onDelete}
          onDownload={onDownload}
          onVerify={onVerify}
        />
      </div>
    </li>
  );
}

export function ModelsPage({
  activeAction,
  error,
  isLoading,
  manager,
  notice,
  onDelete,
  onDownload,
  onRetry,
  onVerify,
}: ModelsPageProps) {
  return (
    <div aria-busy={isLoading || undefined} className="space-y-[var(--or-setup-section-gap)]">
      <Alert title="Local by design" variant="info">
        Models are optional local files. OpenRepurpose downloads nothing until you choose a model
        and start the transfer.
      </Alert>

      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Reload models
            </Button>
          }
          title="Model request failed"
          variant="error"
        >
          {error}
        </Alert>
      )}
      {notice !== undefined && (
        <Alert aria-live="polite" title="Model manager updated" variant="success">
          {notice}
        </Alert>
      )}

      {isLoading && manager === undefined ? (
        <Panel
          aria-live="polite"
          className="flex items-center gap-[var(--or-space-3)]"
          role="status"
        >
          <Spinner />
          <p className="[font-size:var(--or-type-interface-size)]">Reading local model storage…</p>
        </Panel>
      ) : (
        manager !== undefined && (
          <>
            <section aria-labelledby="model-storage-heading">
              <div className="flex flex-wrap items-end justify-between gap-[var(--or-space-3)]">
                <div>
                  <h2
                    className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
                    id="model-storage-heading"
                  >
                    Model storage
                  </h2>
                  <p className="mt-[var(--or-space-2)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
                    Configure this host path with{' '}
                    <code className="font-[family-name:var(--or-font-technical)]" translate="no">
                      WHISPER_MODEL_DIR
                    </code>{' '}
                    before starting OpenRepurpose.
                  </p>
                </div>
                <Badge variant="neutral">{formatBytes(manager.availableBytes)} free</Badge>
              </div>
              <Panel className="mt-[var(--or-space-4)]" surface="inset">
                <dl className="grid gap-[var(--or-space-2)] sm:grid-cols-[var(--or-shell-navigator-min-width)_minmax(0,1fr)] sm:gap-x-[var(--or-space-4)]">
                  <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)]">
                    Active directory
                  </dt>
                  <dd
                    className="min-w-0 break-all font-[family-name:var(--or-font-technical)] text-[var(--or-text-primary)] [font-size:var(--or-type-metadata-size)]"
                    translate="no"
                  >
                    {manager.storagePath}
                  </dd>
                  <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)]">
                    Safety reserve
                  </dt>
                  <dd className="text-[var(--or-text-primary)] tabular-nums [font-size:var(--or-type-metadata-size)]">
                    {formatBytes(manager.reserveBytes)} remains free after preflight
                  </dd>
                </dl>
              </Panel>
            </section>

            <section aria-labelledby="model-catalog-heading">
              <div className="flex flex-wrap items-end justify-between gap-[var(--or-space-3)]">
                <div>
                  <h2
                    className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
                    id="model-catalog-heading"
                  >
                    Whisper model catalog
                  </h2>
                  <p className="mt-[var(--or-space-2)] max-w-[var(--or-measure-prose)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
                    Start small for faster drafts, then choose a larger model when language coverage
                    or transcription accuracy matters more than local runtime.
                  </p>
                </div>
                <Badge variant="neutral">
                  {manager.models.length} {manager.models.length === 1 ? 'model' : 'models'}
                </Badge>
              </div>
              <Panel className="mt-[var(--or-space-4)]" padding="none">
                <ul
                  aria-label="Available transcription models"
                  className="divide-y divide-[var(--or-border-subtle)]"
                >
                  {manager.models.map((model) => (
                    <ModelRow
                      activeAction={activeAction}
                      key={model.id}
                      model={model}
                      onDelete={onDelete}
                      onDownload={onDownload}
                      onVerify={onVerify}
                    />
                  ))}
                </ul>
              </Panel>
            </section>
          </>
        )
      )}
    </div>
  );
}

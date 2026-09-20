import { PlatformSectionHeader } from '../../components/patterns';
import { Alert, Badge, Button, Panel, Spinner } from '../../components/ui';

export interface SetupCredentialStatusView {
  readonly configured: boolean;
  readonly redirectUri: string;
}

export interface TikTokSetupCredentialStatusView extends SetupCredentialStatusView {
  readonly flow: 'desktop' | 'web';
}

export interface SetupPageProps {
  readonly error: string | undefined;
  readonly isLoading: boolean;
  readonly onRetry: () => void;
  readonly tiktokStatus: TikTokSetupCredentialStatusView | undefined;
  readonly youtubeStatus: SetupCredentialStatusView | undefined;
}

interface CredentialSetupPanelProps {
  readonly configured: boolean;
  readonly description: string;
  readonly platform: 'tiktok' | 'youtube';
  readonly redirectUri: string;
  readonly title: string;
  readonly warning?: string;
}

function CredentialSetupPanel({
  configured,
  description,
  platform,
  redirectUri,
  title,
  warning,
}: CredentialSetupPanelProps) {
  const headingId = `${platform}-setup-title`;

  return (
    <Panel aria-labelledby={headingId} padding="setup" surface="surface">
      <PlatformSectionHeader
        description={description}
        headingId={headingId}
        platform={platform}
        title={title}
        trailing={
          <Badge variant={configured ? 'success' : 'warning'}>
            {configured ? 'Configured' : 'Action required'}
          </Badge>
        }
      />

      <dl className="mt-[var(--or-space-5)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]">
        <div className="grid min-w-0 gap-[var(--or-space-1)] sm:grid-cols-[var(--or-shell-navigator-min-width)_minmax(0,1fr)] sm:gap-[var(--or-space-4)]">
          <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
            OAuth callback
          </dt>
          <dd className="min-w-0 break-all font-mono text-[var(--or-text-secondary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
            <code translate="no">{redirectUri}</code>
          </dd>
        </div>
      </dl>

      {warning !== undefined && (
        <Alert className="mt-[var(--or-space-5)]" title="Publishing limitation" variant="warning">
          {warning}
        </Alert>
      )}
    </Panel>
  );
}

export function SetupPage({
  error,
  isLoading,
  onRetry,
  tiktokStatus,
  youtubeStatus,
}: SetupPageProps) {
  return (
    <div aria-busy={isLoading || undefined} className="space-y-[var(--or-setup-section-gap)]">
      <section aria-labelledby="destination-readiness-title">
        <h2
          className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
          id="destination-readiness-title"
        >
          Destination readiness
        </h2>
        <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
          Check the local credentials and callback addresses required before connecting publishing
          accounts.
        </p>
      </section>

      {error !== undefined && (
        <Alert
          action={
            <Button onClick={onRetry} size="sm" variant="secondary">
              Retry setup check
            </Button>
          }
          title="Setup status unavailable"
          variant="error"
        >
          {error}
        </Alert>
      )}

      {isLoading && (
        <Panel aria-live="polite" padding="setup" role="status" surface="surface">
          <div className="flex items-center gap-[var(--or-space-3)]">
            <Spinner size="sm" />
            <div>
              <p className="font-semibold text-[var(--or-text-primary)]">Checking setup status…</p>
              <p className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
                Reading the local credential configuration.
              </p>
            </div>
          </div>
        </Panel>
      )}

      {!isLoading && youtubeStatus !== undefined && tiktokStatus !== undefined && (
        <div className="space-y-[var(--or-space-4)]">
          <CredentialSetupPanel
            configured={youtubeStatus.configured}
            description="BYO Google OAuth desktop client"
            platform="youtube"
            redirectUri={youtubeStatus.redirectUri}
            title="YouTube credentials"
          />
          <CredentialSetupPanel
            configured={tiktokStatus.configured}
            description={`BYO TikTok Login Kit app · ${tiktokStatus.flow} flow`}
            platform="tiktok"
            redirectUri={tiktokStatus.redirectUri}
            title="TikTok credentials"
            warning="TikTok unaudited clients can publish only with private visibility."
          />
        </div>
      )}
    </div>
  );
}

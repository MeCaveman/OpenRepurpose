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
  readonly kickStatus: SetupCredentialStatusView | undefined;
  readonly metaStatus: SetupCredentialStatusView | undefined;
  readonly onRetry: () => void;
  readonly tiktokStatus: TikTokSetupCredentialStatusView | undefined;
  readonly twitchStatus: SetupCredentialStatusView | undefined;
  readonly youtubeStatus: SetupCredentialStatusView | undefined;
}

interface CredentialSetupPanelProps {
  readonly configured: boolean;
  readonly description: string;
  readonly guideHref: string;
  readonly limitation: string;
  readonly platform: 'kick' | 'meta' | 'tiktok' | 'twitch' | 'youtube';
  readonly redirectUri: string;
  readonly title: string;
  readonly warning?: string;
}

function CredentialSetupPanel({
  configured,
  description,
  guideHref,
  limitation,
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

      <Alert
        className="mt-[var(--or-space-5)]"
        title={warning === undefined ? 'Capability boundary' : 'Publishing limitation'}
        variant={warning === undefined ? 'info' : 'warning'}
      >
        {warning ?? limitation}
      </Alert>

      <p className="mt-[var(--or-space-4)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
        <a
          className="font-medium text-[var(--or-text-link)] underline decoration-[var(--or-border-selected)] underline-offset-4"
          href={guideHref}
        >
          Open the local setup guide
        </a>
      </p>
    </Panel>
  );
}

export function SetupPage({
  error,
  isLoading,
  kickStatus,
  metaStatus,
  onRetry,
  tiktokStatus,
  twitchStatus,
  youtubeStatus,
}: SetupPageProps) {
  return (
    <div aria-busy={isLoading || undefined} className="space-y-[var(--or-setup-section-gap)]">
      <section aria-labelledby="setup-sequence-title">
        <h2
          className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
          id="setup-sequence-title"
        >
          From install to first route
        </h2>
        <p className="mt-[var(--or-space-2)] max-w-[var(--or-measure-prose)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
          OpenRepurpose runs on this machine. Complete these steps in order, then keep the browser
          closed or open while persisted jobs continue in the local server.
        </p>
        <Panel className="mt-[var(--or-space-5)]" padding="setup" surface="surface">
          <ol aria-label="Setup sequence" className="space-y-[var(--or-space-4)]">
            {[
              {
                href: '/docs#quick-start',
                label: 'Verify the installation',
                text: 'Run doctor, confirm FFmpeg when media transforms are needed, and review where local data is stored.',
              },
              {
                href: '#destination-readiness-title',
                label: 'Add developer credentials',
                text: 'Use your own platform apps. Credentials and OAuth tokens remain in the encrypted local vault.',
              },
              {
                href: '/accounts',
                label: 'Connect accounts and targets',
                text: 'Complete platform consent and review the exact capabilities granted to each account.',
              },
              {
                href: '/workflows',
                label: 'Build the first workflow',
                text: 'Choose a source, optional transforms, and one or more supported destinations.',
              },
            ].map((step, index) => (
              <li
                className="grid grid-cols-[var(--or-control-compact-height)_minmax(0,1fr)] gap-[var(--or-space-3)]"
                key={step.href}
              >
                <span
                  aria-hidden="true"
                  className="grid size-[var(--or-control-compact-height)] place-items-center rounded-[var(--or-radius-sm)] border border-[var(--or-border-selected)] bg-[var(--or-bg-selected)] font-mono text-[var(--or-text-link)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <a
                    className="font-semibold text-[var(--or-text-primary)] underline decoration-[var(--or-border-selected)] underline-offset-4 [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]"
                    href={step.href}
                  >
                    {step.label}
                  </a>
                  <p className="mt-[var(--or-space-1)] text-pretty text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </section>

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

      {!isLoading && (
        <div className="space-y-[var(--or-space-4)]">
          {youtubeStatus !== undefined && (
            <CredentialSetupPanel
              configured={youtubeStatus.configured}
              description="BYO Google OAuth client"
              guideHref="/docs#platforms"
              limitation="YouTube uploads require the YouTube Data API and the youtube.upload scope."
              platform="youtube"
              redirectUri={youtubeStatus.redirectUri}
              title="YouTube credentials"
              warning="Uploads from affected unverified Google API projects are restricted to private viewing until the project passes YouTube's compliance audit."
            />
          )}
          {tiktokStatus !== undefined && (
            <CredentialSetupPanel
              configured={tiktokStatus.configured}
              description={`BYO TikTok Login Kit app · ${tiktokStatus.flow} flow`}
              guideHref="/docs#platforms"
              limitation="TikTok Direct Post requires video.publish and creator-specific capability checks."
              platform="tiktok"
              redirectUri={tiktokStatus.redirectUri}
              title="TikTok credentials"
              warning="TikTok unaudited clients can publish only with private visibility."
            />
          )}
          {metaStatus !== undefined && (
            <CredentialSetupPanel
              configured={metaStatus.configured}
              description="BYO Meta app for Facebook Pages and Instagram professional accounts"
              guideHref="/docs#platforms"
              limitation="Personal Facebook profiles, groups, and consumer Instagram accounts are not supported. App Review or Advanced Access may be required outside app-role testing."
              platform="meta"
              redirectUri={metaStatus.redirectUri}
              title="Meta credentials"
            />
          )}
          {twitchStatus !== undefined && (
            <CredentialSetupPanel
              configured={twitchStatus.configured}
              description="BYO Twitch application for source polling"
              guideHref="/docs#platforms"
              limitation="Official clip downloads require broadcaster/editor authorization. VOD metadata does not provide reusable media bytes through this integration."
              platform="twitch"
              redirectUri={twitchStatus.redirectUri}
              title="Twitch credentials"
            />
          )}
          {kickStatus !== undefined && (
            <CredentialSetupPanel
              configured={kickStatus.configured}
              description="BYO Kick application for channel and livestream metadata"
              guideHref="/docs#platforms"
              limitation="Kick is metadata-only in OpenRepurpose. Its supported official API path does not provide clip, VOD, replay, or livestream media downloads."
              platform="kick"
              redirectUri={kickStatus.redirectUri}
              title="Kick credentials"
            />
          )}
        </div>
      )}
    </div>
  );
}

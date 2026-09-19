import type { FormEventHandler, ReactNode } from 'react';

import {
  ConnectionCard,
  ConnectionStatus,
  PlatformIdentity,
  ResourceEmptyState,
} from '../../components/patterns';
import { Alert, Badge, Button, Checkbox, FormField, Input, Panel } from '../../components/ui';

export interface AccountView {
  readonly capabilities: readonly string[];
  readonly displayName: string;
  readonly externalId: string;
  readonly id: string;
  readonly provider: string;
  readonly status: string;
}

export interface CredentialStatusView {
  readonly configured: boolean;
  readonly redirectUri: string;
}

export interface TikTokCredentialStatusView extends CredentialStatusView {
  readonly flow: 'desktop' | 'web';
}

export interface MetaCredentialView {
  readonly displayName: string;
  readonly externalId: string;
  readonly id: string;
  readonly scopes: readonly string[];
  readonly status: string;
  readonly tokenExpiresAt: string;
}

export interface MetaTargetView {
  readonly availability: string;
  readonly blocker?: string;
  readonly credentialId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: string;
  readonly pageId: string;
  readonly username?: string;
}

export interface TikTokCapabilitiesView {
  readonly creator?: { readonly nickname: string; readonly username: string };
  readonly directPostAvailable: boolean;
  readonly grantedScopes: readonly string[];
  readonly media?: { readonly maxVideoDurationSeconds: number };
  readonly privacyLevelOptions: readonly string[];
  readonly publicPostingAvailability:
    'not_authorized' | 'requires_audit_confirmation' | 'unavailable_for_creator';
}

export type TikTokCapabilityView =
  | { readonly capabilities: TikTokCapabilitiesView; readonly error?: never }
  | { readonly capabilities?: never; readonly error: string };

export interface AccountsPageProps {
  readonly accounts: readonly AccountView[];
  readonly activeAction: string | undefined;
  readonly error: string | undefined;
  readonly feedback: {
    readonly meta: string | null;
    readonly tiktok: string | null;
    readonly youtube: string | null;
  };
  readonly meta: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly credentials: readonly MetaCredentialView[];
    readonly status: CredentialStatusView | undefined;
    readonly targets: readonly MetaTargetView[];
  };
  readonly onConnectMeta: () => void;
  readonly onConnectTikTok: () => void;
  readonly onConnectYouTube: () => void;
  readonly onMetaClientIdChange: (value: string) => void;
  readonly onMetaClientSecretChange: (value: string) => void;
  readonly onMetaTargetChange: (target: MetaTargetView, enabled: boolean) => void;
  readonly onRediscoverMetaTargets: (credentialId: string) => void;
  readonly onRemoveAccount: (accountId: string) => void;
  readonly onSaveMeta: FormEventHandler<HTMLFormElement>;
  readonly onSaveTikTok: FormEventHandler<HTMLFormElement>;
  readonly onSaveYouTube: FormEventHandler<HTMLFormElement>;
  readonly onTikTokClientKeyChange: (value: string) => void;
  readonly onTikTokClientSecretChange: (value: string) => void;
  readonly onYouTubeClientIdChange: (value: string) => void;
  readonly onYouTubeClientSecretChange: (value: string) => void;
  readonly tiktok: {
    readonly capabilities: Readonly<Record<string, TikTokCapabilityView>>;
    readonly clientKey: string;
    readonly clientSecret: string;
    readonly status: TikTokCredentialStatusView | undefined;
  };
  readonly youtube: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly status: CredentialStatusView | undefined;
  };
}

interface CredentialPanelProps {
  readonly children: ReactNode;
  readonly description: string;
  readonly platform: 'meta' | 'tiktok' | 'youtube';
  readonly status: CredentialStatusView | undefined;
  readonly title: string;
}

function CredentialPanel({ children, description, platform, status, title }: CredentialPanelProps) {
  const headingId = `${platform}-credentials-title`;

  return (
    <Panel aria-labelledby={headingId} padding="setup" surface="surface">
      <header className="flex flex-col gap-[var(--or-space-4)] sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-[var(--or-space-3)]">
          <PlatformIdentity platform={platform} showLabel={false} />
          <div className="min-w-0">
            <h2
              className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id={headingId}
            >
              {title}
            </h2>
            <p className="mt-[var(--or-space-1)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              {description}
            </p>
          </div>
        </div>
        <Badge
          className="self-start"
          variant={status === undefined ? 'neutral' : status.configured ? 'success' : 'warning'}
        >
          {status === undefined ? 'Checking…' : status.configured ? 'Configured' : 'Setup required'}
        </Badge>
      </header>
      {children}
    </Panel>
  );
}

function CallbackAddress({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="mt-[var(--or-space-5)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-4)]">
      <div className="grid min-w-0 gap-[var(--or-space-1)] sm:grid-cols-[var(--or-shell-navigator-min-width)_minmax(0,1fr)] sm:gap-[var(--or-space-4)]">
        <dt className="font-medium text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
          OAuth callback
        </dt>
        <dd className="min-w-0 break-all font-mono text-[var(--or-text-secondary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
          <code translate="no">{children}</code>
        </dd>
      </div>
    </dl>
  );
}

function FeedbackAlerts({ feedback }: Pick<AccountsPageProps, 'feedback'>) {
  const hasFeedback =
    feedback.youtube === 'connected' ||
    feedback.youtube === 'error' ||
    feedback.tiktok === 'connected' ||
    feedback.tiktok === 'error' ||
    feedback.meta === 'connected';

  if (!hasFeedback) return null;

  return (
    <div aria-label="Connection results" className="space-y-[var(--or-space-3)]">
      {feedback.youtube === 'connected' && (
        <Alert title="YouTube connected" variant="success">
          The publishing account is ready to use.
        </Alert>
      )}
      {feedback.youtube === 'error' && (
        <Alert title="YouTube connection failed" variant="error">
          Check the credential setup and try again.
        </Alert>
      )}
      {feedback.tiktok === 'connected' && (
        <Alert title="TikTok connected" variant="success">
          The publishing account is ready to use.
        </Alert>
      )}
      {feedback.tiktok === 'error' && (
        <Alert title="TikTok connection failed" variant="error">
          Check the credential setup and granted scopes.
        </Alert>
      )}
      {feedback.meta === 'connected' && (
        <Alert title="Meta connected" variant="success">
          Available Pages and linked Instagram professional accounts were discovered.
        </Alert>
      )}
    </div>
  );
}

function MetaTargets({
  activeAction,
  credentials,
  onRediscover,
  onTargetChange,
  targets,
}: {
  readonly activeAction: string | undefined;
  readonly credentials: readonly MetaCredentialView[];
  readonly onRediscover: (credentialId: string) => void;
  readonly onTargetChange: (target: MetaTargetView, enabled: boolean) => void;
  readonly targets: readonly MetaTargetView[];
}) {
  if (credentials.length === 0) return null;

  return (
    <div className="mt-[var(--or-space-6)] space-y-[var(--or-space-4)] border-t border-[var(--or-border-subtle)] pt-[var(--or-space-5)]">
      {credentials.map((credential) => {
        const credentialTargets = targets
          .filter((target) => target.credentialId === credential.id)
          .toSorted(
            (left, right) =>
              left.kind.localeCompare(right.kind) ||
              left.displayName.localeCompare(right.displayName),
          );

        return (
          <section
            aria-labelledby={`meta-credential-${credential.id}`}
            className="rounded-[var(--or-radius-md)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-workspace)] p-[var(--or-pane-padding)]"
            key={credential.id}
          >
            <header className="flex flex-col gap-[var(--or-space-3)] sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3
                  className="font-semibold text-[var(--or-text-primary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]"
                  id={`meta-credential-${credential.id}`}
                >
                  {credential.displayName}
                </h3>
                <p className="mt-[var(--or-space-1)] break-all font-mono text-[var(--or-text-tertiary)] [font-size:var(--or-type-metadata-size)] [line-height:var(--or-type-metadata-line)]">
                  <span translate="no">{credential.externalId}</span> · permissions:{' '}
                  {credential.scopes.length === 0 ? 'none reported' : credential.scopes.join(', ')}
                </p>
              </div>
              <ConnectionStatus
                state={credential.status === 'connected' ? 'connected' : 'attention'}
              />
            </header>

            {credential.status !== 'connected' && (
              <Alert className="mt-[var(--or-space-4)]" variant="warning">
                Reconnect this Meta identity before publishing.
              </Alert>
            )}

            <Button
              className="mt-[var(--or-space-4)]"
              isLoading={activeAction === `meta-refresh:${credential.id}`}
              loadingLabel="Refreshing targets…"
              onClick={() => onRediscover(credential.id)}
              size="sm"
              variant="secondary"
            >
              Refresh available targets
            </Button>

            {credentialTargets.length === 0 ? (
              <Alert
                className="mt-[var(--or-space-4)]"
                title="No publishing targets"
                variant="warning"
              >
                Check Meta app review, Page roles, and account eligibility.
              </Alert>
            ) : (
              <div className="mt-[var(--or-space-4)] space-y-[var(--or-space-2)]">
                {credentialTargets.map((target) => {
                  const isAvailable = target.availability === 'available';
                  const isUpdating = activeAction === `meta-target:${target.id}`;
                  const targetType =
                    target.kind === 'facebook_page'
                      ? 'Facebook Page target'
                      : 'Instagram professional target';

                  return (
                    <div
                      className="rounded-[var(--or-radius-sm)] border border-[var(--or-border-subtle)] bg-[var(--or-bg-surface)] px-[var(--or-space-3)] py-[var(--or-space-1)]"
                      key={target.id}
                    >
                      <Checkbox
                        checked={target.enabled}
                        description={
                          <span className="space-y-[var(--or-space-1)]">
                            <span className="block">
                              {targetType}
                              {target.username === undefined ? '' : ` · @${target.username}`}
                            </span>
                            {target.blocker !== undefined && (
                              <span className="block text-[var(--or-status-warning-fg)]">
                                Permission/review blocker: {target.blocker}
                              </span>
                            )}
                          </span>
                        }
                        disabled={!isAvailable || isUpdating}
                        label={
                          <span className="flex flex-wrap items-center justify-between gap-[var(--or-space-2)]">
                            <PlatformIdentity
                              label={target.displayName}
                              platform={target.kind === 'facebook_page' ? 'facebook' : 'instagram'}
                              size="sm"
                            />
                            <Badge
                              variant={isUpdating ? 'info' : isAvailable ? 'success' : 'warning'}
                            >
                              {isUpdating ? 'Updating…' : isAvailable ? 'Available' : 'Unavailable'}
                            </Badge>
                          </span>
                        }
                        onChange={(event) => onTargetChange(target, event.target.checked)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ConnectedAccounts({
  accounts,
  activeAction,
  capabilities,
  onRemoveAccount,
}: {
  readonly accounts: readonly AccountView[];
  readonly activeAction: string | undefined;
  readonly capabilities: Readonly<Record<string, TikTokCapabilityView>>;
  readonly onRemoveAccount: (accountId: string) => void;
}) {
  return (
    <section aria-labelledby="connected-accounts-title">
      <div>
        <h2
          className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
          id="connected-accounts-title"
        >
          Connected accounts
        </h2>
        <p className="mt-[var(--or-space-1)] text-[var(--or-text-secondary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
          Publishing identities available to workflow destinations on this installation.
        </p>
      </div>

      {accounts.length === 0 ? (
        <ResourceEmptyState
          className="mt-[var(--or-space-4)]"
          description="Save platform credentials and connect a publishing account before choosing it as a workflow destination."
          title="No publishing accounts"
        />
      ) : (
        <div className="mt-[var(--or-space-4)] grid gap-[var(--or-space-3)]">
          {accounts.map((account) => {
            const tiktokView = capabilities[account.id];
            return (
              <ConnectionCard
                actions={
                  <Button
                    isLoading={activeAction === `account-remove:${account.id}`}
                    loadingLabel="Removing connection…"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove the local connection for ${account.displayName}? Workflows that reference it may require attention.`,
                        )
                      ) {
                        onRemoveAccount(account.id);
                      }
                    }}
                    size="sm"
                    variant="danger"
                  >
                    Remove local connection
                  </Button>
                }
                externalId={account.externalId}
                key={account.id}
                name={account.displayName}
                platform={account.provider}
                status={account.status === 'connected' ? 'connected' : 'attention'}
              >
                {account.provider === 'youtube' ? (
                  <p>
                    Upload:{' '}
                    {account.capabilities.includes('youtube.video.upload')
                      ? 'allowed'
                      : 'not granted'}{' '}
                    · Identity:{' '}
                    {account.capabilities.includes('youtube.identity.read')
                      ? 'available'
                      : 'not granted'}
                  </p>
                ) : account.provider === 'tiktok' && tiktokView?.capabilities !== undefined ? (
                  <div className="space-y-[var(--or-space-2)]">
                    <p>Granted scopes: {tiktokView.capabilities.grantedScopes.join(', ')}</p>
                    <p>
                      Direct Post:{' '}
                      {tiktokView.capabilities.directPostAvailable
                        ? 'available for this creator'
                        : 'video.publish not granted'}
                    </p>
                    {tiktokView.capabilities.creator !== undefined && (
                      <p>
                        Live creator: @{tiktokView.capabilities.creator.username} · up to{' '}
                        {tiktokView.capabilities.media?.maxVideoDurationSeconds}s ·{' '}
                        {tiktokView.capabilities.privacyLevelOptions.join(', ')}
                      </p>
                    )}
                    <p className="text-[var(--or-status-warning-fg)]">
                      Public posting:{' '}
                      {tiktokView.capabilities.publicPostingAvailability ===
                      'requires_audit_confirmation'
                        ? 'creator allows it, but TikTok app audit must be confirmed'
                        : tiktokView.capabilities.publicPostingAvailability ===
                            'unavailable_for_creator'
                          ? 'not offered for this creator'
                          : 'not authorized'}
                      . Unaudited clients are private-only.
                    </p>
                  </div>
                ) : account.provider === 'tiktok' && tiktokView?.error !== undefined ? (
                  <p className="text-[var(--or-status-warning-fg)]">{tiktokView.error}</p>
                ) : account.provider === 'tiktok' ? (
                  <p aria-live="polite" className="text-[var(--or-text-tertiary)]">
                    Loading live TikTok posting availability…
                  </p>
                ) : (
                  <p>
                    {account.capabilities.length === 0
                      ? 'No publishing capabilities reported.'
                      : `Granted capabilities: ${account.capabilities.join(', ')}`}
                  </p>
                )}
              </ConnectionCard>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function AccountsPage({
  accounts,
  activeAction,
  error,
  feedback,
  meta,
  onConnectMeta,
  onConnectTikTok,
  onConnectYouTube,
  onMetaClientIdChange,
  onMetaClientSecretChange,
  onMetaTargetChange,
  onRediscoverMetaTargets,
  onRemoveAccount,
  onSaveMeta,
  onSaveTikTok,
  onSaveYouTube,
  onTikTokClientKeyChange,
  onTikTokClientSecretChange,
  onYouTubeClientIdChange,
  onYouTubeClientSecretChange,
  tiktok,
  youtube,
}: AccountsPageProps) {
  return (
    <div className="space-y-[var(--or-setup-section-gap)]">
      <FeedbackAlerts feedback={feedback} />

      {error !== undefined && (
        <Alert title="Account action unavailable" variant="error">
          {error}
        </Alert>
      )}

      <section aria-labelledby="platform-connections-title">
        <h2
          className="font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
          id="platform-connections-title"
        >
          Platform connections
        </h2>
        <p className="mt-[var(--or-space-2)] max-w-[var(--or-empty-state-max-width)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
          Bring your own developer credentials, then authorize the publishing identities used by
          workflows. Secrets and tokens remain encrypted on this machine.
        </p>
      </section>

      <div className="space-y-[var(--or-space-4)]">
        <CredentialPanel
          description="Use a Google Cloud desktop OAuth client for YouTube publishing and identity access."
          platform="youtube"
          status={youtube.status}
          title="Google OAuth credentials"
        >
          <form className="mt-[var(--or-space-5)]" onSubmit={onSaveYouTube}>
            <div className="grid gap-[var(--or-field-group-gap)] lg:grid-cols-2">
              <FormField label="Client ID" required>
                <Input
                  autoComplete="off"
                  name="youtube-client-id"
                  onChange={(event) => onYouTubeClientIdChange(event.target.value)}
                  placeholder="Example: …apps.googleusercontent.com"
                  spellCheck={false}
                  value={youtube.clientId}
                />
              </FormField>
              <FormField label="Client secret (optional)">
                <Input
                  autoComplete="new-password"
                  name="youtube-client-secret"
                  onChange={(event) => onYouTubeClientSecretChange(event.target.value)}
                  type="password"
                  value={youtube.clientSecret}
                />
              </FormField>
            </div>
            <div className="mt-[var(--or-space-4)] flex flex-wrap gap-[var(--or-space-2)]">
              <Button
                isLoading={activeAction === 'youtube-save'}
                loadingLabel="Saving credentials…"
                type="submit"
                variant="primary"
              >
                Save credentials
              </Button>
              <Button
                disabled={youtube.status?.configured !== true}
                isLoading={activeAction === 'youtube-connect'}
                loadingLabel="Starting connection…"
                onClick={onConnectYouTube}
              >
                Connect YouTube
              </Button>
            </div>
          </form>
          <CallbackAddress>{youtube.status?.redirectUri ?? 'Loading…'}</CallbackAddress>
        </CredentialPanel>

        <CredentialPanel
          description="Connect one Meta identity, then independently enable its Facebook Pages and linked Instagram professional accounts."
          platform="meta"
          status={meta.status}
          title="Meta app and publishing targets"
        >
          <form className="mt-[var(--or-space-5)]" onSubmit={onSaveMeta}>
            <div className="grid gap-[var(--or-field-group-gap)] lg:grid-cols-2">
              <FormField label="Meta app ID" required>
                <Input
                  autoComplete="off"
                  name="meta-client-id"
                  onChange={(event) => onMetaClientIdChange(event.target.value)}
                  spellCheck={false}
                  value={meta.clientId}
                />
              </FormField>
              <FormField label="Meta app secret" required>
                <Input
                  autoComplete="new-password"
                  name="meta-client-secret"
                  onChange={(event) => onMetaClientSecretChange(event.target.value)}
                  type="password"
                  value={meta.clientSecret}
                />
              </FormField>
            </div>
            <div className="mt-[var(--or-space-4)] flex flex-wrap gap-[var(--or-space-2)]">
              <Button
                isLoading={activeAction === 'meta-save'}
                loadingLabel="Saving Meta credentials…"
                type="submit"
                variant="primary"
              >
                Save Meta credentials
              </Button>
              <Button
                disabled={meta.status?.configured !== true}
                isLoading={activeAction === 'meta-connect'}
                loadingLabel="Starting connection…"
                onClick={onConnectMeta}
              >
                Connect Meta
              </Button>
            </div>
          </form>
          <CallbackAddress>{meta.status?.redirectUri ?? 'Loading…'}</CallbackAddress>
          <MetaTargets
            activeAction={activeAction}
            credentials={meta.credentials}
            onRediscover={onRediscoverMetaTargets}
            onTargetChange={onMetaTargetChange}
            targets={meta.targets}
          />
        </CredentialPanel>

        <CredentialPanel
          description="Use a TikTok developer app with Login Kit and the Content Posting API."
          platform="tiktok"
          status={tiktok.status}
          title="TikTok Login Kit credentials"
        >
          <Alert className="mt-[var(--or-space-5)]" title="Publishing limitation" variant="warning">
            Unaudited TikTok apps are private-only. Request <code>user.info.basic</code> and{' '}
            <code>video.publish</code>; non-private posting requires a successful TikTok audit and
            is never assumed.
          </Alert>
          <form className="mt-[var(--or-space-5)]" onSubmit={onSaveTikTok}>
            <div className="grid gap-[var(--or-field-group-gap)] lg:grid-cols-2">
              <FormField label="Client key" required>
                <Input
                  autoComplete="off"
                  name="tiktok-client-key"
                  onChange={(event) => onTikTokClientKeyChange(event.target.value)}
                  spellCheck={false}
                  value={tiktok.clientKey}
                />
              </FormField>
              <FormField label="Client secret" required>
                <Input
                  autoComplete="new-password"
                  name="tiktok-client-secret"
                  onChange={(event) => onTikTokClientSecretChange(event.target.value)}
                  type="password"
                  value={tiktok.clientSecret}
                />
              </FormField>
            </div>
            <div className="mt-[var(--or-space-4)] flex flex-wrap gap-[var(--or-space-2)]">
              <Button
                isLoading={activeAction === 'tiktok-save'}
                loadingLabel="Saving TikTok credentials…"
                type="submit"
                variant="primary"
              >
                Save TikTok credentials
              </Button>
              <Button
                disabled={tiktok.status?.configured !== true}
                isLoading={activeAction === 'tiktok-connect'}
                loadingLabel="Starting connection…"
                onClick={onConnectTikTok}
              >
                Connect TikTok
              </Button>
            </div>
          </form>
          <CallbackAddress>
            {tiktok.status === undefined
              ? 'Loading…'
              : `${tiktok.status.flow === 'desktop' ? 'Desktop + PKCE' : 'HTTPS web'} · ${tiktok.status.redirectUri}`}
          </CallbackAddress>
        </CredentialPanel>
      </div>

      <ConnectedAccounts
        accounts={accounts}
        activeAction={activeAction}
        capabilities={tiktok.capabilities}
        onRemoveAccount={onRemoveAccount}
      />

      <Alert title="YouTube API visibility" variant="warning">
        Google may limit uploads from unverified API projects. OpenRepurpose shows granted
        capabilities but cannot override Google audit or visibility rules.
      </Alert>
    </div>
  );
}

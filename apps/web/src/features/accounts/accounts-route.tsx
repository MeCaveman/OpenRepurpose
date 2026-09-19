import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import { AccountsPage } from './accounts-page';
import type {
  AccountView,
  CredentialStatusView,
  MetaCredentialView,
  MetaTargetView,
  TikTokCapabilitiesView,
  TikTokCapabilityView,
  TikTokCredentialStatusView,
} from './accounts-page';

interface AccountsResponse {
  readonly accounts: readonly AccountView[];
  readonly meta?: CredentialStatusView;
  readonly metaCredentials?: readonly MetaCredentialView[];
  readonly metaTargets?: readonly MetaTargetView[];
  readonly tiktok: TikTokCredentialStatusView;
  readonly youtube: CredentialStatusView;
}

export function AccountsRoute() {
  const [accounts, setAccounts] = useState<readonly AccountView[]>([]);
  const [youtubeStatus, setYoutubeStatus] = useState<CredentialStatusView>();
  const [youtubeClientId, setYoutubeClientId] = useState('');
  const [youtubeClientSecret, setYoutubeClientSecret] = useState('');
  const [tiktokStatus, setTikTokStatus] = useState<TikTokCredentialStatusView>();
  const [tiktokClientKey, setTikTokClientKey] = useState('');
  const [tiktokClientSecret, setTikTokClientSecret] = useState('');
  const [metaStatus, setMetaStatus] = useState<CredentialStatusView>();
  const [metaClientId, setMetaClientId] = useState('');
  const [metaClientSecret, setMetaClientSecret] = useState('');
  const [metaCredentials, setMetaCredentials] = useState<readonly MetaCredentialView[]>([]);
  const [metaTargets, setMetaTargets] = useState<readonly MetaTargetView[]>([]);
  const [tiktokCapabilities, setTikTokCapabilities] = useState<
    Readonly<Record<string, TikTokCapabilityView>>
  >({});
  const [activeAction, setActiveAction] = useState<string>();
  const [error, setError] = useState<string>();

  const loadAccounts = async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error('Account status is unavailable.');
    const body = (await response.json()) as AccountsResponse;
    setAccounts(body.accounts);
    setYoutubeStatus(body.youtube);
    setTikTokStatus(body.tiktok);
    setMetaStatus(body.meta);
    setMetaCredentials(body.metaCredentials ?? []);
    setMetaTargets(body.metaTargets ?? []);

    const views = await Promise.all(
      body.accounts
        .filter((account) => account.provider === 'tiktok')
        .map(async (account): Promise<readonly [string, TikTokCapabilityView]> => {
          const capabilityResponse = await fetch(
            `/api/accounts/tiktok/${encodeURIComponent(account.id)}/capabilities`,
          );
          const capabilityBody = (await capabilityResponse.json()) as {
            capabilities?: TikTokCapabilitiesView;
            error?: string;
          };
          return [
            account.id,
            capabilityResponse.ok && capabilityBody.capabilities !== undefined
              ? { capabilities: capabilityBody.capabilities }
              : { error: capabilityBody.error ?? 'TikTok posting availability is unavailable.' },
          ];
        }),
    );
    setTikTokCapabilities(Object.fromEntries(views));
  };

  useEffect(() => {
    void loadAccounts().catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : 'Could not load accounts.'),
    );
  }, []);

  const saveYouTubeCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAction('youtube-save');
    try {
      const response = await fetch('/api/accounts/youtube/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ clientId: youtubeClientId, clientSecret: youtubeClientSecret }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'YouTube credentials could not be saved.');
      setYoutubeClientId('');
      setYoutubeClientSecret('');
      await loadAccounts();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'YouTube credentials could not be saved.',
      );
    } finally {
      setActiveAction(undefined);
    }
  };

  const connect = async (provider: 'meta' | 'tiktok' | 'youtube') => {
    setError(undefined);
    setActiveAction(`${provider}-connect`);
    const label = provider === 'meta' ? 'Meta' : provider === 'tiktok' ? 'TikTok' : 'YouTube';
    try {
      const response = await fetch(`/api/accounts/${provider}/oauth/start`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': await getCsrfToken() },
      });
      const body = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || body.authorizationUrl === undefined)
        throw new Error(body.error ?? `${label} authorization could not be started.`);
      window.location.assign(body.authorizationUrl);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : `${label} authorization could not be started.`,
      );
    } finally {
      setActiveAction(undefined);
    }
  };

  const saveMetaCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAction('meta-save');
    try {
      const response = await fetch('/api/accounts/meta/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ clientId: metaClientId, clientSecret: metaClientSecret }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ??
            'Meta credentials could not be saved.',
        );
      setMetaClientId('');
      setMetaClientSecret('');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Meta credentials could not be saved.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const setMetaTarget = async (target: MetaTargetView, enabled: boolean) => {
    setError(undefined);
    setActiveAction(`meta-target:${target.id}`);
    try {
      const response = await fetch(`/api/accounts/meta/targets/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error('Meta target could not be updated.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Meta target could not be updated.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const rediscoverMetaTargets = async (credentialId: string) => {
    setError(undefined);
    setActiveAction(`meta-refresh:${credentialId}`);
    try {
      const response = await fetch(
        `/api/accounts/meta/${encodeURIComponent(credentialId)}/discover`,
        { method: 'POST', headers: { 'X-CSRF-Token': await getCsrfToken() } },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Meta targets could not be refreshed.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Meta targets could not be refreshed.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const saveTikTokCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAction('tiktok-save');
    try {
      const response = await fetch('/api/accounts/tiktok/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ clientKey: tiktokClientKey, clientSecret: tiktokClientSecret }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'TikTok credentials could not be saved.');
      setTikTokClientKey('');
      setTikTokClientSecret('');
      await loadAccounts();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'TikTok credentials could not be saved.',
      );
    } finally {
      setActiveAction(undefined);
    }
  };

  const removeAccount = async (accountId: string) => {
    setError(undefined);
    setActiveAction(`account-remove:${accountId}`);
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': await getCsrfToken() },
      });
      if (!response.ok) throw new Error('The account could not be removed.');
      await loadAccounts();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The account could not be removed.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const query = new URLSearchParams(window.location.search);

  return (
    <AccountsPage
      accounts={accounts}
      activeAction={activeAction}
      error={error}
      feedback={{
        meta: query.get('meta'),
        tiktok: query.get('tiktok'),
        youtube: query.get('youtube'),
      }}
      meta={{
        clientId: metaClientId,
        clientSecret: metaClientSecret,
        credentials: metaCredentials,
        status: metaStatus,
        targets: metaTargets,
      }}
      onConnectMeta={() => void connect('meta')}
      onConnectTikTok={() => void connect('tiktok')}
      onConnectYouTube={() => void connect('youtube')}
      onMetaClientIdChange={setMetaClientId}
      onMetaClientSecretChange={setMetaClientSecret}
      onMetaTargetChange={(target, enabled) => void setMetaTarget(target, enabled)}
      onRediscoverMetaTargets={(credentialId) => void rediscoverMetaTargets(credentialId)}
      onRemoveAccount={(accountId) => void removeAccount(accountId)}
      onSaveMeta={saveMetaCredentials}
      onSaveTikTok={saveTikTokCredentials}
      onSaveYouTube={saveYouTubeCredentials}
      onTikTokClientKeyChange={setTikTokClientKey}
      onTikTokClientSecretChange={setTikTokClientSecret}
      onYouTubeClientIdChange={setYoutubeClientId}
      onYouTubeClientSecretChange={setYoutubeClientSecret}
      tiktok={{
        capabilities: tiktokCapabilities,
        clientKey: tiktokClientKey,
        clientSecret: tiktokClientSecret,
        status: tiktokStatus,
      }}
      youtube={{
        clientId: youtubeClientId,
        clientSecret: youtubeClientSecret,
        status: youtubeStatus,
      }}
    />
  );
}

import { useEffect, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import { SourcesPage } from './sources-page';
import type { SourceAccountView, SourceConnectionView, SourceItemView } from './sources-page';

export interface SourcesRouteProps {
  readonly onNavigateAccounts: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function SourcesRoute({ onNavigateAccounts }: SourcesRouteProps) {
  const [accounts, setAccounts] = useState<readonly SourceAccountView[]>([]);
  const [sources, setSources] = useState<readonly SourceConnectionView[]>([]);
  const [itemsBySource, setItemsBySource] = useState<
    Readonly<Record<string, readonly SourceItemView[]>>
  >({});
  const [accountId, setAccountId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [activeAction, setActiveAction] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  const loadAccounts = async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error('Account status is unavailable.');
    const body = (await response.json()) as { accounts: readonly SourceAccountView[] };
    setAccounts(body.accounts);
  };

  const loadSources = async () => {
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error('Source status is unavailable.');
    const body = (await response.json()) as { sources: readonly SourceConnectionView[] };
    setSources(body.sources);
    const details = await Promise.all(
      body.sources.map(async (source) => {
        const itemResponse = await fetch(`/api/sources/${encodeURIComponent(source.id)}`);
        const itemBody = (await itemResponse.json()) as { items?: readonly SourceItemView[] };
        return [source.id, itemBody.items ?? []] as const;
      }),
    );
    setItemsBySource(Object.fromEntries(details));
  };

  useEffect(() => {
    setIsLoading(true);
    void Promise.all([loadAccounts(), loadSources()])
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load sources.'),
      )
      .finally(() => setIsLoading(false));
  }, []);

  const addYouTubeSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setActiveAction('add');
    try {
      const response = await fetch('/api/sources/youtube', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify({ accountId, channelId, displayName }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ?? 'Could not add source.',
        );
      setChannelId('');
      setDisplayName('');
      await loadSources();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not add source.');
    } finally {
      setActiveAction(undefined);
    }
  };

  const sourceAction = async (id: string, action: 'pause' | 'poll' | 'resume') => {
    setError(undefined);
    setActiveAction(`${action}:${id}`);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': await getCsrfToken() },
      });
      if (!response.ok) throw new Error('Source update failed.');
      await loadSources();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Source update failed.');
    } finally {
      setActiveAction(undefined);
    }
  };

  return (
    <SourcesPage
      accounts={accounts}
      activeAction={activeAction}
      draft={{ accountId, channelId, displayName }}
      error={error}
      isLoading={isLoading}
      itemsBySource={itemsBySource}
      onAccountIdChange={setAccountId}
      onAddSource={addYouTubeSource}
      onChannelIdChange={setChannelId}
      onDisplayNameChange={setDisplayName}
      onNavigateAccounts={onNavigateAccounts}
      onSourceAction={(sourceId, action) => void sourceAction(sourceId, action)}
      sources={sources}
    />
  );
}

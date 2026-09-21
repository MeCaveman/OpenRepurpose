import { useEffect, useState } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import { ModelsPage } from './models-page';
import type { ModelManagerView, TranscriptionModelView } from './models-page';

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function ModelsRoute() {
  const [manager, setManager] = useState<ModelManagerView>();
  const [isLoading, setIsLoading] = useState(true);
  const [activeAction, setActiveAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadModels = async () => {
    const response = await fetch('/api/transcription/models');
    if (!response.ok)
      throw new Error(await responseError(response, 'The local model catalog is unavailable.'));
    const body = (await response.json()) as ModelManagerView;
    setManager(body);
    return body;
  };

  const reload = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      await loadModels();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load transcription models.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const isDownloading = manager?.models.some((model) => model.status === 'downloading') ?? false;
  useEffect(() => {
    if (!isDownloading) return;
    const timer = window.setInterval(() => {
      void loadModels().catch(() => undefined);
    }, 750);
    return () => window.clearInterval(timer);
  }, [isDownloading]);

  const mutate = async (modelId: string, action: 'delete' | 'download' | 'verify') => {
    setActiveAction(`${action}:${modelId}`);
    setError(undefined);
    setNotice(undefined);
    const encodedId = encodeURIComponent(modelId);
    const path =
      action === 'delete'
        ? `/api/transcription/models/${encodedId}`
        : `/api/transcription/models/${encodedId}/${action}`;
    try {
      const response = await fetch(path, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: { 'X-CSRF-Token': await getCsrfToken() },
      });
      if (!response.ok) throw new Error(await responseError(response, `Model ${action} failed.`));
      await loadModels();
      setNotice(
        action === 'download'
          ? 'Download started. You can leave this page while the local server continues the transfer.'
          : action === 'verify'
            ? 'The installed model matches its published checksum.'
            : 'The model was removed from local storage.',
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Model ${action} failed.`);
    } finally {
      setActiveAction(undefined);
    }
  };

  const deleteModel = (model: TranscriptionModelView) => {
    if (
      window.confirm(
        `Delete ${model.displayName}? The local model file will be removed and must be downloaded again before it can be used.`,
      )
    )
      void mutate(model.id, 'delete');
  };

  return (
    <ModelsPage
      activeAction={activeAction}
      error={error}
      isLoading={isLoading}
      manager={manager}
      notice={notice}
      onDelete={deleteModel}
      onDownload={(modelId) => void mutate(modelId, 'download')}
      onRetry={() => void reload()}
      onVerify={(modelId) => void mutate(modelId, 'verify')}
    />
  );
}

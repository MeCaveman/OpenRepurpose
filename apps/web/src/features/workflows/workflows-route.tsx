import { useEffect, useState } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import type { WorkflowEditorValue } from './workflow-editor';
import { WorkflowsPage } from './workflows-page';
import type {
  WorkflowAccountView,
  WorkflowPresetView,
  WorkflowSourceView,
  WorkflowTargetView,
  WorkflowView,
} from './workflows-page';

export function WorkflowsRoute() {
  const [accounts, setAccounts] = useState<readonly WorkflowAccountView[]>([]);
  const [metaTargets, setMetaTargets] = useState<readonly WorkflowTargetView[]>([]);
  const [sources, setSources] = useState<readonly WorkflowSourceView[]>([]);
  const [presets, setPresets] = useState<readonly WorkflowPresetView[]>([]);
  const [workflows, setWorkflows] = useState<readonly WorkflowView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();

  const loadAccounts = async () => {
    const response = await fetch('/api/accounts');
    if (!response.ok) throw new Error('Account status is unavailable.');
    const body = (await response.json()) as {
      accounts: readonly WorkflowAccountView[];
      metaTargets?: readonly WorkflowTargetView[];
    };
    setAccounts(body.accounts);
    setMetaTargets(body.metaTargets ?? []);
  };

  const loadSources = async () => {
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error('Source status is unavailable.');
    const body = (await response.json()) as { sources: readonly WorkflowSourceView[] };
    setSources(body.sources);
  };

  const loadWorkflows = async () => {
    const response = await fetch('/api/workflows');
    if (!response.ok) throw new Error('Workflow list is unavailable.');
    const body = (await response.json()) as { workflows: readonly WorkflowView[] };
    setWorkflows(body.workflows);
  };

  const loadPresets = async () => {
    const response = await fetch('/api/workflow-presets');
    if (!response.ok) throw new Error('Workflow presets are unavailable.');
    const body = (await response.json()) as { presets: readonly WorkflowPresetView[] };
    setPresets(body.presets);
  };

  const retryWorkflows = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      await Promise.all([loadAccounts(), loadPresets(), loadWorkflows(), loadSources()]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load workflows.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void retryWorkflows();
  }, []);

  const createWorkflow = async (value: WorkflowEditorValue) => {
    setError(undefined);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await getCsrfToken() },
        body: JSON.stringify(value),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The workflow could not be saved.');
      await loadWorkflows();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The workflow could not be saved.');
    }
  };

  const applyPreset = async (id: WorkflowPresetView['id']): Promise<WorkflowEditorValue> => {
    setError(undefined);
    const response = await fetch(`/api/workflow-presets/${encodeURIComponent(id)}/draft`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': await getCsrfToken() },
    });
    const body = (await response.json()) as {
      draft?: { workflow: WorkflowEditorValue };
      error?: string;
    };
    if (!response.ok || body.draft === undefined) {
      const message = body.error ?? 'The workflow preset could not be applied.';
      setError(message);
      throw new Error(message);
    }
    return body.draft.workflow;
  };

  return (
    <WorkflowsPage
      accounts={accounts}
      error={error}
      isLoading={isLoading}
      metaTargets={metaTargets}
      onApplyPreset={applyPreset}
      onCreateWorkflow={createWorkflow}
      onRetry={() => void retryWorkflows()}
      sources={sources}
      presets={presets}
      workflows={workflows}
    />
  );
}

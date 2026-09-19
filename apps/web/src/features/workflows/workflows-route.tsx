import { useEffect, useState } from 'react';

import { getCsrfToken } from '../../lib/local-api';
import type { WorkflowEditorValue } from './workflow-editor';
import { WorkflowsPage } from './workflows-page';
import type {
  WorkflowAccountView,
  WorkflowSourceView,
  WorkflowTargetView,
  WorkflowView,
} from './workflows-page';

export function WorkflowsRoute() {
  const [accounts, setAccounts] = useState<readonly WorkflowAccountView[]>([]);
  const [metaTargets, setMetaTargets] = useState<readonly WorkflowTargetView[]>([]);
  const [sources, setSources] = useState<readonly WorkflowSourceView[]>([]);
  const [workflows, setWorkflows] = useState<readonly WorkflowView[]>([]);
  const [isLoading, setIsLoading] = useState(false);
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

  useEffect(() => {
    setIsLoading(true);
    void Promise.all([loadAccounts(), loadWorkflows(), loadSources()])
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : 'Could not load workflows.'),
      )
      .finally(() => setIsLoading(false));
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

  return (
    <WorkflowsPage
      accounts={accounts}
      error={error}
      isLoading={isLoading}
      metaTargets={metaTargets}
      onCreateWorkflow={createWorkflow}
      sources={sources}
      workflows={workflows}
    />
  );
}

import { Alert, Panel } from '../../components/ui';

const sections = [
  {
    id: 'quick-start',
    title: 'Quick start',
    body: 'Run openrepurpose doctor, start the server, and open the loopback URL it prints. Windows and Linux portable releases already include Node.js and the production dashboard.',
    details:
      'FFmpeg, ffprobe, whisper.cpp, and transcription models are optional external tools and are not bundled.',
  },
  {
    id: 'platforms',
    title: 'Platform setup',
    body: 'OpenRepurpose uses your own developer applications. Register the exact callback shown in Setup, save credentials under Accounts, then connect only the identities and publishing targets you control.',
    details:
      'YouTube and TikTok audits, Meta App Review, account eligibility, scopes, quotas, and platform processing can restrict an action even after OAuth succeeds.',
  },
  {
    id: 'workflows',
    title: 'Workflows and OBS',
    body: 'A workflow snapshots a source, optional filters or transforms, and one or more destinations. OBS recordings and Replay Buffer outputs use watched folders; the file must settle before import.',
    details:
      'OBS WebSocket is only an optional scan hint. Folder polling remains authoritative and continues when OBS is closed.',
  },
  {
    id: 'backup',
    title: 'Backup and restore',
    body: 'Use openrepurpose backup create for a validated, secret-free database snapshot. Stop OpenRepurpose before restore and reconnect accounts afterward.',
    details:
      'Portable backups exclude OAuth tokens, app secrets, media, derivatives, and models. Pre-upgrade and pre-restore database copies are sensitive local recovery files.',
  },
  {
    id: 'automation',
    title: 'MCP and local API',
    body: 'Run openrepurpose mcp start for the local stdio server. REST clients use /api/v1 with a revocable bearer token created by openrepurpose api token create.',
    details:
      'The browser uses its own local session and CSRF boundary. Never place API tokens in URLs, browser storage, screenshots, or committed configuration.',
  },
  {
    id: 'privacy',
    title: 'Privacy, data, and removal',
    body: 'Application state stays on the host unless a configured workflow sends media or metadata to a selected platform or webhook. No telemetry is sent by default.',
    details:
      'Uninstalling the program does not automatically erase the separate configuration and data directories. Back up what you need, stop the process, then remove those locations deliberately.',
  },
] as const;

export function DocsPage() {
  return (
    <div className="space-y-[var(--or-space-8)]">
      <Alert title="Documentation stays with this installation" variant="neutral">
        This local guide covers the safe path through setup. The release archive and source tree
        also include the complete Markdown guides for platform configuration, deployment,
        troubleshooting, backups, plugins, and data removal.
      </Alert>

      <nav aria-label="Documentation topics">
        <Panel padding="compact" surface="surface">
          <ul className="flex flex-wrap gap-x-[var(--or-space-4)] gap-y-[var(--or-space-2)]">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  className="inline-flex min-h-[var(--or-control-default-height)] items-center font-medium text-[var(--or-text-link)] underline decoration-[var(--or-border-selected)] underline-offset-4 [font-size:var(--or-type-interface-size)]"
                  href={`#${section.id}`}
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      </nav>

      <div className="space-y-[var(--or-space-4)]">
        {sections.map((section) => (
          <Panel
            aria-labelledby={`${section.id}-title`}
            id={section.id}
            key={section.id}
            padding="setup"
            surface="surface"
          >
            <h2
              className="scroll-mt-[var(--or-space-16)] font-semibold tracking-[var(--or-tracking-section)] text-[var(--or-text-primary)] [font-size:var(--or-type-section-size)] [line-height:var(--or-type-section-line)]"
              id={`${section.id}-title`}
            >
              {section.title}
            </h2>
            <p className="mt-[var(--or-space-3)] max-w-[var(--or-measure-prose)] text-pretty text-[var(--or-text-secondary)] [font-size:var(--or-type-body-size)] [line-height:var(--or-type-body-line)]">
              {section.body}
            </p>
            <p className="mt-[var(--or-space-2)] max-w-[var(--or-measure-prose)] text-pretty text-[var(--or-text-tertiary)] [font-size:var(--or-type-interface-size)] [line-height:var(--or-type-body-line)]">
              {section.details}
            </p>
          </Panel>
        ))}
      </div>

      <p className="[font-size:var(--or-type-interface-size)] [line-height:var(--or-type-interface-line)]">
        <a
          className="font-medium text-[var(--or-text-link)] underline decoration-[var(--or-border-selected)] underline-offset-4"
          href="/setup"
        >
          Return to setup readiness
        </a>
      </p>
    </div>
  );
}

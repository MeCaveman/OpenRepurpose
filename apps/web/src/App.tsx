import { useEffect, useState } from 'react';

interface PageDefinition {
  readonly description: string;
  readonly eyebrow: string;
  readonly title: string;
}

const pages: Readonly<Record<string, PageDefinition>> = {
  '/': {
    eyebrow: 'Local workspace',
    title: 'Your media pipeline, on your machine.',
    description:
      'OpenRepurpose is ready for local setup. Media, accounts, workflows, and jobs arrive in their owning v0.1 packets.',
  },
  '/setup': {
    eyebrow: 'System readiness',
    title: 'Setup',
    description: 'Configuration and dependency checks will appear here as capabilities are added.',
  },
  '/accounts': {
    eyebrow: 'Destinations',
    title: 'Accounts',
    description: 'Connected publishing accounts will be managed here.',
  },
  '/media': {
    eyebrow: 'Local library',
    title: 'Media',
    description: 'Imported local media and probe details will be listed here.',
  },
  '/workflows': {
    eyebrow: 'Automation',
    title: 'Workflows',
    description: 'Source-to-destination workflow controls will live here.',
  },
  '/jobs': {
    eyebrow: 'Execution history',
    title: 'Jobs',
    description: 'Persistent job state, attempts, and actionable errors will appear here.',
  },
  '/settings': {
    eyebrow: 'Local configuration',
    title: 'Settings',
    description: 'Deployment-neutral application preferences will be managed here.',
  },
};

const navigation = [
  ['/', 'Dashboard'],
  ['/setup', 'Setup'],
  ['/accounts', 'Accounts'],
  ['/media', 'Media'],
  ['/workflows', 'Workflows'],
  ['/jobs', 'Jobs'],
  ['/settings', 'Settings'],
] as const;

function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', updatePathname);
    return () => window.removeEventListener('popstate', updatePathname);
  }, []);
  return pathname;
}

export function App() {
  const pathname = usePathname();
  const page = pages[pathname] ?? {
    eyebrow: 'Not found',
    title: 'This local view does not exist.',
    description: 'Choose a section from the navigation to continue.',
  };

  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/10 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
          <a className="flex items-center gap-3" href="/" onClick={(event) => navigate(event, '/')}>
            <span className="grid size-9 place-items-center rounded-xl bg-cyan-300 font-black text-slate-950">
              OR
            </span>
            <span>
              <span className="block text-sm font-semibold">OpenRepurpose</span>
              <span className="block text-xs text-slate-400">Local media automation</span>
            </span>
          </a>
          <div className="flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1.5 text-xs font-medium text-emerald-200">
            <span className="size-2 rounded-full bg-emerald-300" aria-hidden="true" />
            Local only
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-8 lg:grid-cols-[14rem_1fr] lg:px-8">
        <nav aria-label="Primary navigation" className="flex gap-2 overflow-x-auto lg:flex-col">
          {navigation.map(([href, label]) => {
            const active = pathname === href;
            return (
              <a
                aria-current={active ? 'page' : undefined}
                className={`shrink-0 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-cyan-300 font-semibold text-slate-950'
                    : 'text-slate-300 hover:bg-white/5 hover:text-white'
                }`}
                href={href}
                key={href}
                onClick={(event) => navigate(event, href)}
              >
                {label}
              </a>
            );
          })}
        </nav>

        <main>
          <section className="overflow-hidden rounded-3xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/20">
            <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.18),transparent_45%)] px-7 py-10 sm:px-10">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">
                {page.eyebrow}
              </p>
              <h1 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight sm:text-5xl">
                {page.title}
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
                {page.description}
              </p>
            </div>
            <div className="grid gap-4 p-7 sm:grid-cols-3 sm:p-10">
              {[
                ['Private by default', 'The server binds to loopback and rejects untrusted hosts.'],
                ['Restart-safe core', 'SQLite migrations preserve local state across restarts.'],
                [
                  'One execution path',
                  'Web, CLI, and future workers share application boundaries.',
                ],
              ].map(([title, description]) => (
                <article
                  className="rounded-2xl border border-white/10 bg-slate-950/60 p-5"
                  key={title}
                >
                  <h2 className="text-sm font-semibold text-white">{title}</h2>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

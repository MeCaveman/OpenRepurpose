import { Component } from 'react';
import type { ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(): void {
    // Packet 6 introduces centralized redacted logging. Do not emit arbitrary render errors yet.
  }

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100">
          <section className="max-w-lg rounded-2xl border border-rose-400/30 bg-slate-900 p-8 shadow-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-rose-300">
              Interface error
            </p>
            <h1 className="mt-3 text-2xl font-semibold">
              OpenRepurpose could not render this view.
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              Your local jobs and files are unaffected. Reload the interface to try again.
            </p>
            <button
              className="mt-6 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-200"
              onClick={() => window.location.reload()}
              type="button"
            >
              Reload interface
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

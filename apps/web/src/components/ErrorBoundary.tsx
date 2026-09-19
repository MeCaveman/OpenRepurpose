import { Component } from 'react';
import type { ReactNode } from 'react';

import { Button, ErrorState } from './ui';

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
        <main className="grid min-h-screen place-items-center bg-[var(--or-bg-canvas)] px-[var(--or-space-6)] text-[var(--or-text-primary)]">
          <ErrorState
            action={
              <Button onClick={() => window.location.reload()} variant="primary">
                Reload interface
              </Button>
            }
            description="Your local jobs and files are unaffected. Reload the interface to try again."
            headingLevel={1}
            title="OpenRepurpose could not render this view."
          />
        </main>
      );
    }

    return this.props.children;
  }
}

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-app)] p-8">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
            Something went wrong
          </h1>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            An unexpected error occurred. Try reloading the app.
          </p>
          {this.state.error && (
            <pre className="text-xs text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] rounded-lg p-3 mb-4 text-left overflow-auto max-h-32 break-words whitespace-pre-wrap">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-[var(--purple-accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--purple-accent-hover)] transition-colors"
          >
            Reload App
          </button>
        </div>
      </div>
    );
  }
}

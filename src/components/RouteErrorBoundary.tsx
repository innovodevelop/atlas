import { Component, type ReactNode } from 'react';

interface State { error: Error | null }

/** App-level boundary so a render error shows a message instead of a blank page. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { console.error('[RouteErrorBoundary]', error); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'hsl(240 28% 7%)', color: 'hsl(240 30% 90%)', fontFamily: 'Manrope, system-ui, sans-serif' }}>
          <div style={{ maxWidth: 640 }}>
            <h1 style={{ fontFamily: 'Sora, sans-serif', fontWeight: 400, fontSize: 22 }}>Something went wrong</h1>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'hsl(350 75% 72%)', marginTop: 12 }}>{this.state.error.message}</pre>
            <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '10px 16px', borderRadius: 12, background: 'hsl(243 75% 58%)', border: 'none', color: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>Retry</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

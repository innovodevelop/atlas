import { LogIn } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Empty, Panel } from './primitives';

/**
 * The third state: not "empty", not "loading" — *unread*.
 *
 * `/atlas-core` and `/settings` are not auth-gated, and every account-scoped
 * hook behind them (`useAgents`, `useSchedules`, `useToolCalls`,
 * `useAgentRuns`, `useApprovals`) resolves immediately without issuing a query
 * when there is no user. That is the right thing for the hook — a signed-out
 * read is finished, not pending — but it left the panels asserting a fact about
 * data they never looked at: "No agents yet", "No runs", "No tokens recorded".
 *
 * Those sentences are the exact failure mode the surrounding pass exists to
 * remove. A panel that did not read cannot report a count, so it says so.
 */
export function SignedOut({ what }: { what: string }) {
  const navigate = useNavigate();
  return (
    <Panel>
      <Empty
        size="block"
        title="Sign in to see this"
        body={`${what} is stored against your account. Atlas has not read anything — this is not an empty list, it is an unread one.`}
        icon={<LogIn className="i20" />}
        status="stale"
        action={{ label: 'Sign in', onClick: () => navigate('/auth') }}
      />
    </Panel>
  );
}

export default SignedOut;

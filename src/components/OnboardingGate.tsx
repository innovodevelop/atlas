import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { readOnboarding } from '@/lib/atlasPermissions';

// Send a first-run user to /permissions even when they arrive already signed in.
//
// The redirect in Auth.tsx only fires on the auth -> app TRANSITION. A returning
// session skips that screen entirely and lands straight on the dashboard, which
// for a fresh account is completely empty (no memories, tasks or insights yet)
// and therefore has nothing to click — indistinguishable from a frozen app.
// Gating here means the first thing anyone sees is something that talks back.
export function OnboardingGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // Decide synchronously so the dashboard never paints for one frame first.
  const [needsOnboarding] = useState(() => readOnboarding() === null);

  useEffect(() => {
    if (needsOnboarding) navigate('/permissions', { replace: true });
  }, [needsOnboarding, navigate]);

  if (needsOnboarding) return null;
  return <>{children}</>;
}

export default OnboardingGate;

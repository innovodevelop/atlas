import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { readOnboarding } from '@/lib/atlasPermissions';

// Send a first-run user to /permissions even when they arrive already signed in.
//
// The redirect in Auth.tsx only fires on the auth -> app TRANSITION. A returning
// session skips that screen entirely and lands on the dashboard, which for a
// fresh account is genuinely empty (0 memories/tasks/insights) and therefore has
// nothing to click — indistinguishable from a frozen app.
//
// DECLARATIVE redirect, deliberately. The first version returned `null` and
// navigated from a useEffect; in the packaged WKWebView that effect did not take
// effect, so the gate sat rendering null forever and the whole window went blank
// ("React did not mount within 8s" from the index.html crash reporter). <Navigate>
// performs the redirect as part of the render commit instead of depending on an
// effect firing, and it never has a state in which it renders nothing.
//
// It also fails OPEN: any error reading the stored record is treated as
// "already onboarded", so a storage quirk can only cost the onboarding screen —
// never the entire app.
export function OnboardingGate({ children }: { children: ReactNode }) {
  let needsOnboarding = false;
  try {
    needsOnboarding = readOnboarding() === null;
  } catch {
    needsOnboarding = false;
  }

  if (needsOnboarding) return <Navigate to="/permissions" replace />;
  return <>{children}</>;
}

export default OnboardingGate;

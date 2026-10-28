/**
 * The Beta first-run consent — `/permissions` while the beta_ui flag is on.
 *
 * The route the onboarding gate (src/components/OnboardingGate.tsx) sends a
 * new account to, and the one Auth lands on after a sign-up. The Entry design
 * draws consent as the middle of one flow (intro → permissions → macOS asks →
 * welcome), so this is that flow — the same component `/onboarding` renders —
 * under the gate's path. It writes the same record the gate reads, so
 * "Enter Atlas" passes it.
 */
import { BetaOnboardingFlow } from './atlas/BetaOnboarding';

const BetaPermissions = () => <BetaOnboardingFlow route="permissions" />;

export default BetaPermissions;

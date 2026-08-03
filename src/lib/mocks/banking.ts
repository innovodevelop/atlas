/**
 * Atlas Banking — the sample dataset behind `/money`.
 *
 * THIS FILE IS FICTION, AND THE SURFACE SAYS SO ON SCREEN.
 *
 * There is no money data source in Atlas. `src/hooks/usePortfolio.ts` reaches a
 * local Rust/DuckDB bridge for *brokerage* holdings and returns nothing without
 * a SnapTrade link; the bank side — balances, transactions, cards, entities —
 * has no adapter at all. Atlas's Mastercard Open Finance registration is
 * SANDBOX ONLY, so no bank can be connected from a shipped build. Every figure
 * below is design copy lifted from `Atlas Banking.dc.html`.
 *
 * That makes this the most dangerous mock in the bundle: numbers with currency
 * symbols read as fact. The rule this module and its surface follow is that the
 * label travels with the data — `AtlasBanking.tsx` renders a standing notice,
 * and `<MoneyCard>` stamps SAMPLE into the header of every single card. Neither
 * is optional decoration; strip them and this becomes exactly the fabricated-row
 * problem T4 spent a week deleting from Atlas Core.
 *
 * ── HOW A REAL ADAPTER REPLACES THIS ──────────────────────────────────────
 *
 * `useBankingData()` is the whole seam. It returns a `BankingSnapshot` and takes
 * no arguments, so a real hook — say `src/hooks/useBanking.ts`, backed by Tauri
 * commands over the local SQLite core the way `usePortfolio` is — swaps in by
 * changing ONE import line in `src/pages/atlas/AtlasBanking.tsx`:
 *
 *     -import { useBankingData, IS_MOCK } from '@/lib/mocks/banking';
 *     +import { useBankingData, IS_MOCK } from '@/hooks/useBanking';
 *
 * with `IS_MOCK = false` there. The page already renders the day-one shape a
 * real adapter returns on its first call — `accounts: null` — as a designed
 * empty state, so nothing else in the surface has to change.
 *
 * The snapshot is split deliberately:
 *
 *   `policy`   — provider registration and what Atlas is permitted to do.
 *                Product facts, true with or without a connection, and the only
 *                part of this file that is NOT fiction.
 *   `accounts` — everything bank-sourced. `null` until a bank is connected,
 *                which the shipped app cannot do.
 */

/* -------------------------------------------------------------------------
 * Types — the contract a real adapter has to satisfy.
 * ---------------------------------------------------------------------- */

/** Which colour a card's accent and stamp take. See `banking.css` §categories. */
export type MoneyCategory = 'balance' | 'spend' | 'card' | 'save' | 'biz' | 'risk';

/** How a card renders its payload. The design's seven body shapes. */
export type MoneyCardKind = 'big' | 'rows' | 'bars' | 'progress' | 'split' | 'card' | 'text';

/** The entity a card belongs to. `all` is the unfiltered view, never a card's own value. */
export type MoneyScope = 'all' | 'personal' | 'business';

export interface MoneyRow {
  label: string;
  value: string;
}

export interface MoneyCardData {
  id: string;
  /** Header label, uppercased by CSS. */
  name: string;
  /** Right-aligned header meta — the design's `kicker`. */
  kicker: string;
  category: MoneyCategory;
  kind: MoneyCardKind;
  /** Which scope filters show this card. A card may belong to both entities. */
  entities: Array<Exclude<MoneyScope, 'all'>>;
  /** Primary figure. Pre-formatted by the adapter — the surface never does currency maths. */
  value?: string;
  /** Second figure: the right half of a `split`, the last four digits of a `card`. */
  value2?: string;
  /** Change indicator beside `value`. Rendered in the category accent. */
  delta?: string;
  caption?: string;
  caption2?: string;
  /** `progress` only — 0–100. */
  pct?: number;
  /** `rows` only. The card truncates to what its height can hold. */
  items?: MoneyRow[];
  /** `bars` only — relative heights, 0–100. The card truncates to its width. */
  bars?: number[];
}

/** Where a card sits on the 12-column, 126px-row grid. */
export interface MoneyPlacement {
  id: string;
  cols: 2 | 3 | 6;
  rows: 1 | 2 | 3;
}

export interface HeroSummary {
  label: string;
  value: string;
  line: string;
}

export interface ConnectedBank {
  id: string;
  name: string;
  /** Single-letter mark. A real adapter supplies the institution logo instead. */
  initial: string;
  /** Brand colour for the mark tile. */
  mark: string;
  kind: 'personal' | 'joint' | 'business';
  accounts: string;
  balance: string;
  /** Open-banking consents expire; this is the renewal line. */
  consent: string;
  /** True when the consent needs renewing soon — drives the amber treatment. */
  consentDue: boolean;
}

export interface BankingEntity {
  id: string;
  name: string;
  meta: string;
  value: string;
}

export interface SuggestedBank {
  id: string;
  name: string;
  initial: string;
  meta: string;
  mark: string;
}

/**
 * A line in "What Atlas may do".
 *
 * `locked` is not a disabled state — it is a permanent product guarantee.
 * "Move money" is locked off by design and must never render as something a
 * toggle could turn on.
 */
export interface BankingPermission {
  id: string;
  name: string;
  note: string;
  enabled: boolean;
  locked?: boolean;
}

/** Provider registration. Real facts, not sample data. */
export interface BankingPolicy {
  provider: string;
  environment: 'sandbox' | 'production';
  /** False while the registration is sandbox-only. Gates every connect control. */
  canConnect: boolean;
  reason: string;
  permissions: BankingPermission[];
}

/** Everything bank-sourced. `null` on the snapshot until a bank is connected. */
export interface BankingAccounts {
  hero: Record<MoneyScope, HeroSummary>;
  cards: MoneyCardData[];
  layout: MoneyPlacement[];
  banks: ConnectedBank[];
  entities: BankingEntity[];
  suggested: SuggestedBank[];
  /** ISO timestamp of the last successful sync, or null if never synced. */
  lastSynced: string | null;
}

export interface BankingSnapshot {
  loading: boolean;
  error: string | null;
  policy: BankingPolicy;
  accounts: BankingAccounts | null;
}

/* -------------------------------------------------------------------------
 * The label. Imported by the page; if this is false the page drops the notice
 * and the per-card stamps, so a real adapter gets a clean surface for free.
 * ---------------------------------------------------------------------- */
export const IS_MOCK = true;

/* -------------------------------------------------------------------------
 * Policy — NOT sample data. These five lines are Atlas's actual position on
 * bank access, and the sandbox note is the actual state of the integration.
 * ---------------------------------------------------------------------- */

const POLICY: BankingPolicy = {
  provider: 'Mastercard Open Finance',
  environment: 'sandbox',
  canConnect: false,
  reason:
    'Atlas is registered with Mastercard Open Finance in sandbox only. Production access has not been granted, so no bank can be connected from this build — not by you, and not by Atlas.',
  permissions: [
    {
      id: 'read',
      name: 'Read balances and transactions',
      note: 'Read-only, through your bank’s own consent screen. Atlas never sees your credentials.',
      enabled: true,
    },
    {
      id: 'categorise',
      name: 'Categorise and forecast',
      note: 'On device. Nothing leaves for analysis.',
      enabled: true,
    },
    {
      id: 'move',
      name: 'Move money',
      note: 'Never. Atlas can draft a transfer; you send it yourself in your bank.',
      enabled: false,
      locked: true,
    },
    {
      id: 'remind',
      name: 'Draft invoice reminders',
      note: 'Held for approval like any other mail.',
      enabled: true,
    },
    {
      id: 'mention',
      name: 'Mention money in general answers',
      note: 'Off — figures stay inside this view.',
      enabled: false,
    },
  ],
};

/* -------------------------------------------------------------------------
 * Sample accounts — every value below is design copy from
 * `Atlas Banking.dc.html`. None of it came from a bank.
 * ---------------------------------------------------------------------- */

const CARDS: MoneyCardData[] = [
  // — Balance ————————————————————————————————————————————————
  { id: 'total-balance', name: 'Total balance', kicker: 'Net position', category: 'balance', kind: 'big', entities: ['personal'],
    value: '€84,120', delta: '+2.1%', caption: 'Across 7 accounts, 3 banks' },
  { id: 'current-account', name: 'Current account', kicker: 'Personal', category: 'balance', kind: 'big', entities: ['personal'],
    value: '€6,412', delta: '−€340', caption: 'Revolut · main' },
  { id: 'savings', name: 'Savings', kicker: 'Personal', category: 'balance', kind: 'big', entities: ['personal'],
    value: '€24,800', delta: '+€600', caption: '2.9% AER · instant access' },
  { id: 'joint-account', name: 'Joint account', kicker: 'Shared', category: 'balance', kind: 'big', entities: ['personal'],
    value: '€3,180', delta: '−€120', caption: 'Household bills' },
  { id: 'accounts', name: 'Accounts', kicker: 'All personal', category: 'balance', kind: 'rows', entities: ['personal'],
    value: '7 accounts', caption: 'Three banks connected',
    items: [
      { label: 'Revolut · Current', value: '€6,412' },
      { label: 'N26 · Savings', value: '€24,800' },
      { label: 'Danske · Joint', value: '€3,180' },
      { label: 'Wise · Multi-currency', value: '€2,940' },
    ] },
  { id: 'balance-trend', name: 'Balance trend', kicker: 'Net worth', category: 'balance', kind: 'bars', entities: ['personal'],
    value: '€84.1k', caption: 'Twelve months', bars: [46, 52, 49, 58, 63, 60, 68, 72, 70, 76, 80, 84] },
  { id: 'cash-flow', name: 'Cash flow', kicker: 'July', category: 'balance', kind: 'split', entities: ['personal'],
    value: '€7,240', caption: 'In this month', value2: '€4,905', caption2: 'Out' },
  { id: 'runway', name: 'Runway', kicker: 'Personal', category: 'balance', kind: 'progress', entities: ['personal'],
    value: '8.4 mo', caption: 'at current burn', pct: 70 },
  { id: 'atlas-said', name: 'Atlas said', kicker: 'Voice', category: 'balance', kind: 'text', entities: ['personal', 'business'],
    value: 'Rent clears Friday and leaves €4,962. Ledgerline is 14 days late — I have a reminder drafted and waiting for you.',
    caption: 'Spoken aloud · 08:20' },

  // — Spending ———————————————————————————————————————————————
  { id: 'spending', name: 'Spending', kicker: 'All cards', category: 'spend', kind: 'bars', entities: ['personal'],
    value: '€1,284', caption: 'This month by week', bars: [24, 40, 32, 58, 44, 70, 52] },
  { id: 'categories', name: 'Categories', kicker: 'July', category: 'spend', kind: 'rows', entities: ['personal'],
    value: '€1,284', caption: 'Top four of eleven',
    items: [
      { label: 'Groceries', value: '€412' },
      { label: 'Transport', value: '€236' },
      { label: 'Eating out', value: '€198' },
      { label: 'Subscriptions', value: '€184' },
    ] },
  { id: 'budget', name: 'Budget', kicker: 'Monthly', category: 'spend', kind: 'progress', entities: ['personal'],
    value: '68%', caption: 'of €1,900 used', pct: 68 },
  { id: 'largest-purchase', name: 'Largest purchase', kicker: 'This month', category: 'spend', kind: 'big', entities: ['personal'],
    value: '€389', delta: 'Tue', caption: 'Flight to Lisbon · TAP' },
  { id: 'merchants', name: 'Merchants', kicker: 'July', category: 'spend', kind: 'rows', entities: ['personal'],
    value: '34 merchants', caption: 'Ranked by spend',
    items: [
      { label: 'Netto', value: '€212' },
      { label: 'TAP Air', value: '€389' },
      { label: 'Apple', value: '€74' },
      { label: 'Spotify', value: '€12' },
    ] },
  { id: 'subscriptions', name: 'Subscriptions', kicker: 'Recurring', category: 'spend', kind: 'rows', entities: ['personal'],
    value: '€184/mo', caption: '11 active · 2 unused',
    items: [
      { label: 'Adobe CC', value: '€62/mo' },
      { label: 'Spotify', value: '€12/mo' },
      { label: 'iCloud', value: '€10/mo' },
      { label: 'Notion', value: '€8/mo' },
    ] },
  { id: 'upcoming-bills', name: 'Upcoming bills', kicker: 'Scheduled', category: 'spend', kind: 'rows', entities: ['personal'],
    value: '€1,575', caption: 'Due within 10 days',
    items: [
      { label: 'Rent · 1 Aug', value: '€1,450' },
      { label: 'Insurance · 3 Aug', value: '€96' },
      { label: 'Phone · 5 Aug', value: '€29' },
    ] },
  { id: 'direct-debits', name: 'Direct debits', kicker: 'Mandates', category: 'spend', kind: 'big', entities: ['personal'],
    value: '9 active', caption: 'Next: rent, 1 August' },

  // — Cards ——————————————————————————————————————————————————
  { id: 'main-card', name: 'Main card', kicker: 'Revolut Metal', category: 'card', kind: 'card', entities: ['personal'],
    value: '€1,284', value2: '4471', caption: 'Visa · spent this cycle' },
  { id: 'business-card', name: 'Business card', kicker: 'Pleo', category: 'card', kind: 'card', entities: ['business'],
    value: '€3,908', value2: '8820', caption: 'Mastercard · company' },
  { id: 'card-controls', name: 'Card controls', kicker: 'Limits', category: 'card', kind: 'rows', entities: ['personal', 'business'],
    value: '3 of 4 on', caption: 'Applies to all cards',
    items: [
      { label: 'Online payments', value: 'on' },
      { label: 'Contactless', value: 'on' },
      { label: 'ATM abroad', value: 'off' },
      { label: 'Gambling', value: 'blocked' },
    ] },
  { id: 'pending', name: 'Pending', kicker: 'Authorisations', category: 'card', kind: 'rows', entities: ['personal'],
    value: '€448', caption: 'Not yet settled',
    items: [
      { label: 'TAP Air Portugal', value: '€389' },
      { label: 'Netto', value: '€41' },
      { label: 'Uber', value: '€18' },
    ] },
  { id: 'fx', name: 'FX', kicker: 'Live mid-market', category: 'card', kind: 'split', entities: ['personal', 'business'],
    value: '€1', caption: 'Euro', value2: '$1.09', caption2: 'US dollar' },
  { id: 'multi-currency', name: 'Multi-currency', kicker: 'Balances', category: 'card', kind: 'rows', entities: ['personal'],
    value: '4 wallets', caption: 'Wise · no conversion fees',
    items: [
      { label: 'EUR', value: '€2,940' },
      { label: 'USD', value: '$1,120' },
      { label: 'GBP', value: '£340' },
      { label: 'DKK', value: 'kr 4,200' },
    ] },

  // — Saving —————————————————————————————————————————————————
  { id: 'savings-goal', name: 'Savings goal', kicker: 'Goal', category: 'save', kind: 'progress', entities: ['personal'],
    value: '€24.8k', caption: 'of €30k · house deposit', pct: 82 },
  { id: 'emergency-fund', name: 'Emergency fund', kicker: 'Buffer', category: 'save', kind: 'progress', entities: ['personal'],
    value: '5.2 mo', caption: 'of 6 months target', pct: 87 },
  { id: 'investments', name: 'Investments', kicker: 'Portfolio', category: 'save', kind: 'big', entities: ['personal'],
    value: '€48,200', delta: '+1.8%', caption: 'Index funds and ETFs' },
  { id: 'pension', name: 'Pension', kicker: 'Retirement', category: 'save', kind: 'big', entities: ['personal'],
    value: '€112k', delta: '+4.2%', caption: 'Employer 8% · you 6%' },
  { id: 'interest-earned', name: 'Interest earned', kicker: 'This year', category: 'save', kind: 'big', entities: ['personal'],
    value: '€612', delta: 'YTD', caption: '2.9% average across savings' },
  { id: 'round-ups', name: 'Round-ups', kicker: 'Automatic', category: 'save', kind: 'progress', entities: ['personal'],
    value: '€48', caption: 'saved this month', pct: 40 },

  // — Risk ———————————————————————————————————————————————————
  { id: 'mortgage', name: 'Mortgage', kicker: 'Repaid', category: 'risk', kind: 'progress', entities: ['personal'],
    value: '€218k', caption: 'of €340k remaining', pct: 36 },
  { id: 'loans', name: 'Loans', kicker: 'Outstanding', category: 'risk', kind: 'rows', entities: ['personal'],
    value: '€11,500', caption: 'Two active loans',
    items: [
      { label: 'Car finance', value: '€8,400' },
      { label: 'Student loan', value: '€3,100' },
    ] },
  { id: 'credit-score', name: 'Credit score', kicker: 'Experian', category: 'risk', kind: 'big', entities: ['personal'],
    value: '812', delta: '+14', caption: 'Excellent · updated Monday' },
  { id: 'debt-ratio', name: 'Debt ratio', kicker: 'Healthy', category: 'risk', kind: 'progress', entities: ['personal'],
    value: '22%', caption: 'of gross income', pct: 22 },
  { id: 'unusual-activity', name: 'Unusual activity', kicker: 'Monitoring', category: 'risk', kind: 'text', entities: ['personal'],
    value: 'A €389 charge from TAP Air Portugal is larger than your usual travel spend. It matches your Lisbon booking, so Atlas let it through.',
    caption: 'One flag today' },

  // — Business ———————————————————————————————————————————————
  { id: 'business-balance', name: 'Business balance', kicker: 'Business', category: 'biz', kind: 'big', entities: ['business'],
    value: '€142,600', delta: '+8.4%', caption: 'Kern Studio ApS · operating' },
  { id: 'receivables', name: 'Receivables', kicker: 'Outstanding', category: 'biz', kind: 'rows', entities: ['business'],
    value: '€101.6k', caption: 'Two overdue by 14 days',
    items: [
      { label: 'Northwind', value: '€12,400' },
      { label: 'Ledgerline', value: '€86,000' },
      { label: 'Studio Kern', value: '€3,200' },
    ] },
  { id: 'payables', name: 'Payables', kicker: 'Owed', category: 'biz', kind: 'rows', entities: ['business'],
    value: '€10.1k', caption: 'Due within seven days',
    items: [
      { label: 'AWS · 28 Jul', value: '€1,840' },
      { label: 'Contractors · 31 Jul', value: '€6,200' },
      { label: 'Office · 1 Aug', value: '€2,100' },
    ] },
  { id: 'vat-set-aside', name: 'VAT set aside', kicker: 'Ring-fenced', category: 'biz', kind: 'progress', entities: ['business'],
    value: '€18.4k', caption: 'of €21.2k due 1 Sep', pct: 87 },
  { id: 'payroll', name: 'Payroll', kicker: 'Business', category: 'biz', kind: 'big', entities: ['business'],
    value: '€41,200', delta: 'monthly', caption: '14 people · runs in 3 days' },
  { id: 'corporation-tax', name: 'Corporation tax', kicker: 'Estimated', category: 'biz', kind: 'progress', entities: ['business'],
    value: '€26.8k', caption: 'accrued this year', pct: 62 },
  { id: 'business-runway', name: 'Business runway', kicker: 'Kern Studio', category: 'biz', kind: 'big', entities: ['business'],
    value: '14 mo', delta: '+2', caption: 'At current burn and pipeline' },
  { id: 'invoices-sent', name: 'Invoices sent', kicker: 'Billed', category: 'biz', kind: 'bars', entities: ['business'],
    value: '€214k', caption: 'Last seven months', bars: [30, 42, 38, 56, 62, 48, 70] },
  { id: 'expenses', name: 'Expenses', kicker: 'Business', category: 'biz', kind: 'rows', entities: ['business'],
    value: '€13.9k', caption: 'This month',
    items: [
      { label: 'Software', value: '€3,410' },
      { label: 'Travel', value: '€2,180' },
      { label: 'Office', value: '€2,100' },
      { label: 'Contractors', value: '€6,200' },
    ] },
  { id: 'reconciliation', name: 'Reconciliation', kicker: 'Bookkeeping', category: 'biz', kind: 'progress', entities: ['business'],
    value: '92%', caption: 'of July matched', pct: 92 },
];

/**
 * The money view's placements — the design's `MONEY` array, one entry per card
 * that earns a slot on the default grid. The catalog view ignores this and
 * renders every card in `CARDS` at one chosen size instead.
 */
const LAYOUT: MoneyPlacement[] = [
  { id: 'accounts', cols: 3, rows: 2 },
  { id: 'current-account', cols: 3, rows: 1 },
  { id: 'savings', cols: 3, rows: 1 },
  { id: 'balance-trend', cols: 3, rows: 2 },
  { id: 'cash-flow', cols: 3, rows: 1 },
  { id: 'main-card', cols: 3, rows: 1 },
  { id: 'spending', cols: 3, rows: 1 },
  { id: 'budget', cols: 3, rows: 1 },
  { id: 'upcoming-bills', cols: 3, rows: 2 },
  { id: 'receivables', cols: 3, rows: 2 },
  { id: 'atlas-said', cols: 6, rows: 1 },
  { id: 'business-balance', cols: 3, rows: 1 },
  { id: 'vat-set-aside', cols: 3, rows: 1 },
  { id: 'runway', cols: 3, rows: 1 },
  { id: 'credit-score', cols: 3, rows: 1 },
];

const ACCOUNTS: BankingAccounts = {
  hero: {
    all: {
      label: 'Net position',
      value: '€226,720',
      line: 'Personal and business together. Rent clears Friday, Ledgerline is 14 days late, and VAT is 87% set aside.',
    },
    personal: {
      label: 'Personal',
      value: '€84,120',
      line: 'Across seven accounts at three banks. Spending is 68% of budget with five days of July left.',
    },
    business: {
      label: 'Kern Studio ApS',
      value: '€142,600',
      line: 'Fourteen months of runway. €101.6k receivable, €10.1k payable this week, payroll in three days.',
    },
  },
  cards: CARDS,
  layout: LAYOUT,
  banks: [
    { id: 'revolut', name: 'Revolut', initial: 'R', mark: '#1e1e24', kind: 'personal',
      accounts: 'Current · Savings pocket · Metal card', balance: '€6,412',
      consent: 'Consent renews 12 Sep', consentDue: false },
    { id: 'n26', name: 'N26', initial: 'N', mark: '#0a7a53', kind: 'personal',
      accounts: 'Savings · 2.9% AER', balance: '€24,800',
      consent: 'Consent renews 4 Oct', consentDue: false },
    { id: 'danske', name: 'Danske Bank', initial: 'D', mark: '#2f4bbd', kind: 'joint',
      accounts: 'Joint account · household bills', balance: '€3,180',
      consent: 'Renew within 11 days', consentDue: true },
    { id: 'wise', name: 'Wise', initial: 'W', mark: '#5b3ce0', kind: 'personal',
      accounts: 'EUR, USD, GBP, DKK wallets', balance: '€2,940',
      consent: 'Consent renews 30 Aug', consentDue: false },
    { id: 'pleo', name: 'Pleo', initial: 'P', mark: '#a3352c', kind: 'business',
      accounts: 'Kern Studio ApS · 6 company cards', balance: '€142,600',
      consent: 'Consent renews 21 Nov', consentDue: false },
  ],
  entities: [
    { id: 'personal', name: 'Personal', meta: '4 accounts · Revolut, N26, Wise', value: '€84,120' },
    { id: 'joint', name: 'Joint · household', meta: '1 account · Danske Bank', value: '€3,180' },
    { id: 'kern', name: 'Kern Studio ApS', meta: '2 accounts · 6 cards · VAT registered', value: '€142,600' },
  ],
  suggested: [
    { id: 's-revolut', name: 'Revolut', initial: 'R', meta: 'Personal + business', mark: '#1e1e24' },
    { id: 's-n26', name: 'N26', initial: 'N', meta: 'Personal', mark: '#0a7a53' },
    { id: 's-danske', name: 'Danske Bank', initial: 'D', meta: 'Personal + joint', mark: '#2f4bbd' },
    { id: 's-wise', name: 'Wise', initial: 'W', meta: 'Multi-currency', mark: '#5b3ce0' },
    { id: 's-nordea', name: 'Nordea', initial: 'N', meta: 'Mortgage', mark: '#8b6f3f' },
    { id: 's-pleo', name: 'Pleo', initial: 'P', meta: 'Company cards', mark: '#a3352c' },
  ],
  lastSynced: null,
};

/** The scope filter's chips. Colours are the category accents, not free hues. */
export const MONEY_SCOPES: Array<{ id: MoneyScope; label: string; category: MoneyCategory | 'accent' }> = [
  { id: 'all', label: 'Everything', category: 'accent' },
  { id: 'personal', label: 'Personal', category: 'balance' },
  { id: 'business', label: 'Kern Studio ApS', category: 'biz' },
];

/** The catalog view's five sizes, from the Widget Catalog spec. */
export const CATALOG_SIZES: Array<{ id: string; label: string; dim: string; cols: 2 | 3 | 6; rows: 1 | 2 | 3 }> = [
  { id: 's', label: 'S', dim: '2×1', cols: 2, rows: 1 },
  { id: 'm', label: 'M', dim: '3×1', cols: 3, rows: 1 },
  { id: 'l', label: 'L', dim: '3×2', cols: 3, rows: 2 },
  { id: 'xl', label: 'XL', dim: '6×2', cols: 6, rows: 2 },
  { id: 'hero', label: 'Hero', dim: '6×3', cols: 6, rows: 3 },
];

/**
 * The seam.
 *
 * Synchronous and constant on purpose: a mock that fakes a loading delay teaches
 * the surface a timing it will not actually have. `loading` and `error` exist
 * because a real adapter has them and the page renders both — they are simply
 * never true here.
 */
export function useBankingData(): BankingSnapshot {
  return { loading: false, error: null, policy: POLICY, accounts: ACCOUNTS };
}

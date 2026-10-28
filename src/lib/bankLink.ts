/**
 * The GoCardless bank link, read for the Money screen — what a requisition's
 * status code means to the user, when the once-a-day read is next due, how
 * long the consent has left — and the small decisions the CSV import makes
 * before it writes (row 32, and the import half of row 31, of
 * docs/design-sync/2026-10-28-left-out-features.md).
 *
 * The network half lives in src-tauri/src/bank.rs. Pure, tested beside it.
 */
import type { BankAccountRow, BankLinkRow } from './bankLedger';
import { transactionIds, latestBalance, type ParsedTx } from './bankCsv';

export type LinkTone = 'ok' | 'waiting' | 'dead';

/**
 * GoCardless's requisition codes, in words. CR/GC/UA/SA/GA are steps of the
 * consent the user is still in the middle of; LN is linked; RJ, EX and SU
 * mean the consent is over and the bank must be connected again.
 */
const STATUS: Record<string, { label: string; tone: LinkTone }> = {
  CR: { label: 'Waiting for you at the bank', tone: 'waiting' },
  GC: { label: 'Giving consent at the bank', tone: 'waiting' },
  UA: { label: 'Signing in at the bank', tone: 'waiting' },
  SA: { label: 'Choosing accounts at the bank', tone: 'waiting' },
  GA: { label: 'Granting access', tone: 'waiting' },
  LN: { label: 'Connected', tone: 'ok' },
  RJ: { label: 'The bank refused the consent', tone: 'dead' },
  EX: { label: 'The consent has expired', tone: 'dead' },
  SU: { label: 'Suspended by GoCardless', tone: 'dead' },
};

export function linkStatus(code: string): { label: string; tone: LinkTone } {
  return STATUS[code] ?? { label: `GoCardless says ${code || 'nothing'}`, tone: 'waiting' };
}

const DAY_MS = 86_400_000;

/** Whole days until the consent ends; null when the bank has not linked yet. */
export function consentDaysLeft(link: Pick<BankLinkRow, 'expires_at'>, now: number): number | null {
  if (!link.expires_at) return null;
  const end = Date.parse(link.expires_at);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now) / DAY_MS));
}

/** The once-a-day read is due: never read, or read a day ago or more. */
export function syncDue(link: Pick<BankLinkRow, 'status' | 'last_synced_at'>, now: number): boolean {
  if (link.status !== 'LN') return false;
  if (!link.last_synced_at) return true;
  const last = Date.parse(link.last_synced_at);
  return !Number.isFinite(last) || now - last >= DAY_MS;
}

/** One line under a link: its state, when it was last read and how long consent lasts. */
export function linkLine(link: BankLinkRow, now: number, fmtWhen: (iso: string) => string): string {
  const st = linkStatus(link.status);
  if (st.tone !== 'ok') return st.label;
  const parts = [link.last_synced_at ? `Read ${fmtWhen(link.last_synced_at)}` : 'Not read yet'];
  const left = consentDaysLeft(link, now);
  if (left !== null) parts.push(left <= 7 ? `consent ends in ${left} ${left === 1 ? 'day' : 'days'}` : `consent for ${left} more days`);
  return parts.join(' · ');
}

/** What the key form still lacks; empty means it can be sent to the Keychain. */
export function keyProblems(secretId: string, secretKey: string): string[] {
  const out: string[] = [];
  const id = secretId.trim();
  const key = secretKey.trim();
  if (!id) out.push('Paste the secret ID.');
  else if (/\s/.test(id)) out.push('The secret ID has a space in it.');
  if (!key) out.push('Paste the secret key.');
  else if (/\s/.test(key)) out.push('The secret key has a space in it.');
  return out;
}

/** Institutions matching a search, by name or BIC, keeping GoCardless's order. */
export function filterInstitutions<T extends { name: string; bic: string | null }>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((i) => i.name.toLowerCase().includes(q) || (i.bic ?? '').toLowerCase().includes(q));
}

// --- The CSV import's last step -------------------------------------------------------

export interface StoreRow {
  id: string;
  booked_on: string;
  amount: number;
  currency: string | null;
  text: string;
  balance_after: number | null;
}

/** Parsed rows as the store takes them: each with its stable dedupe id, in the account's currency when the file named none. */
export function storeRows(accountId: string, txs: readonly ParsedTx[], currency: string): StoreRow[] {
  const ids = transactionIds(accountId, txs);
  return txs.map((t, i) => ({ id: ids[i], booked_on: t.booked_on, amount: t.amount, currency: t.currency ?? currency, text: t.text, balance_after: t.balance_after }));
}

/**
 * The account's balance after an import, when the file carries one and it is
 * newer than what the account already knows. An older export never rolls a
 * balance back.
 */
export function balanceAfterImport(account: Pick<BankAccountRow, 'balance' | 'balance_at'>, txs: readonly ParsedTx[]): { balance: number; balance_at: string } | null {
  const latest = latestBalance(txs);
  if (!latest) return null;
  if (account.balance_at && account.balance_at.slice(0, 10) > latest.on) return null;
  return { balance: latest.balance, balance_at: latest.on };
}

/** The import's one-line result. */
export function importSummary(r: { inserted: number; skipped: number; rejected: number }): string {
  const parts = [`${r.inserted} new ${r.inserted === 1 ? 'transaction' : 'transactions'}`];
  if (r.skipped) parts.push(`${r.skipped} already here`);
  if (r.rejected) parts.push(`${r.rejected} ${r.rejected === 1 ? 'row' : 'rows'} without a date or amount left out`);
  return `${parts.join(', ')}.`;
}

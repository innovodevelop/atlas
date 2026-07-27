import type { MailThreadStatus } from '@/types/mail';
import { STATUS_LABELS } from './mailFormat';

/**
 * Status pill. The colour lives entirely in `mail.css` (contract §6.4 fixes the
 * status→token mapping), so this only picks the modifier class.
 */
export const MailStatusChip = ({ status }: { status: MailThreadStatus }) => (
  <span className={`mail-chip mail-chip-${status}`}>{STATUS_LABELS[status]}</span>
);

/**
 * The phone's bell (spec 4.7 "Notification center", C55): portalled into the
 * top bar's page slot, so it is on every page and gone while a layer with its
 * own bar is open. The number is the drawer's Notifications number
 * (attentionCount, the "one count rule"): the cards to answer plus the unread
 * Inbox letters, so the two bells never disagree (N2-05). 0 shows no number.
 * A tap opens the Sidebar's NotificationPanel full screen, as a phone layer.
 */
import { createPortal } from 'react-dom';
import { BellOutlineIcon } from '@/components/common/PhoneIcons';
import { usePhoneTopBarActionSlot } from './PhoneTopBar';

/**
 * R3-05: "need you" is the home's word for TASKS (the Needs-you strip, the row
 * badges); the bell counts notifications, so it says "new". The two numbers
 * count different things and now read as different things.
 */
export function bellAriaLabel(count: number): string {
  return `Notifications, ${count} new`;
}

export function PhoneNotificationBell({ count, open, onOpen }: { count: number; open: boolean; onOpen: () => void }) {
  const slot = usePhoneTopBarActionSlot();
  if (!slot) return null;
  return createPortal(
    <button
      type="button"
      className="phone-topbar-btn phone-bell"
      aria-label={bellAriaLabel(count)}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={onOpen}
      data-testid="phone-bell"
    >
      <BellOutlineIcon size={22} />
      {count > 0 && (
        <span className="phone-bell-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>
      )}
    </button>,
    slot,
  );
}

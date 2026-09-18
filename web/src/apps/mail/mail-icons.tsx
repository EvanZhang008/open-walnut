/**
 * Mailbox role marks. One glyph per role the contract declares, so a folder list reads at a
 * glance instead of as a column of identical rows.
 *
 * They live here rather than in `apps/icons.tsx` because that file is the app RAIL's icon set
 * (one per sidebar row); these are content icons that only the mail console draws.
 */
import type { ReactNode } from 'react';
import type { MailboxRole } from '@/api/mail';

interface IconProps { size?: number }

function frame(size: number, children: ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function InboxIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M3 12l2.5-7h13L21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M3 12h5l1.5 2.5h5L16 12h5" />
  </>);
}

export function SentIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M21 3L3 10.5l6.5 2.5L12 21z" />
    <path d="M21 3L9.5 13" />
  </>);
}

export function DraftsIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <path d="M17.5 2.5a2.1 2.1 0 0 1 3 3L13 13l-4 1 1-4z" />
  </>);
}

export function ArchiveIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </>);
}

export function TrashIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
  </>);
}

export function SpamIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M12 3l9 16H3z" />
    <path d="M12 9v5" />
    <path d="M12 17h.01" />
  </>);
}

export function FolderIcon({ size = 15 }: IconProps) {
  return frame(size, <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
}

export function RefreshIcon({ size = 14 }: IconProps) {
  return frame(size, <>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </>);
}

export function ComposeIcon({ size = 14 }: IconProps) {
  return frame(size, <>
    <path d="M4 20h16" />
    <path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4z" />
  </>);
}

export function ReplyIcon({ size = 14 }: IconProps) {
  return frame(size, <>
    <path d="M9 5L3 11l6 6" />
    <path d="M3 11h9a8 8 0 0 1 8 8" />
  </>);
}

export function ReplyAllIcon({ size = 14 }: IconProps) {
  return frame(size, <>
    <path d="M8 5L2 11l6 6" />
    <path d="M13 5L7 11l6 6" />
    <path d="M7 11h8a7 7 0 0 1 7 7" />
  </>);
}

export function ForwardIcon({ size = 14 }: IconProps) {
  return frame(size, <>
    <path d="M15 5l6 6-6 6" />
    <path d="M21 11h-9a8 8 0 0 0-8 8" />
  </>);
}

export function BackIcon({ size = 14 }: IconProps) {
  return frame(size, <path d="M15 5l-7 7 7 7" />);
}

export function ChevronIcon({ size = 12 }: IconProps) {
  return frame(size, <path d="M6 9l6 6 6-6" />);
}

/**
 * The disclosure chevron of the sidebar groups: points right closed, and CSS rotates it 90deg open.
 *
 * An SVG rather than a CSS triangle or a text glyph on purpose. A character triangle sits on the text
 * baseline, and its size and vertical position differ between WebKit and Chromium, so the Mac app got a
 * chevron that floated above the row it belonged to.
 */
export function TwistIcon({ size = 12 }: IconProps) {
  return frame(size, <path d="M9 6l6 6-6 6" />);
}

export function SearchIcon({ size = 14 }: IconProps) {
  return frame(size, <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>);
}

/** Make a task: a box with a tick, which is what a Walnut todo row looks like. */
export function TaskIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    <path d="M8 12.2l2.8 2.8L16.5 9" />
  </>);
}

/** Mark unread: a sealed envelope. */
export function EnvelopeIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="M3.5 7l8.5 6 8.5-6" />
  </>);
}

/** Mark read: the same envelope, opened. */
export function EnvelopeOpenIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M3 10.5L12 4l9 6.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M3.5 10.8l8.5 5.7 8.5-5.7" />
  </>);
}

/** The one action this console does not have yet, drawn so the gap is visible and honest. */
export function ClipIcon({ size = 15 }: IconProps) {
  return frame(size, <path d="M21 11.5l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />);
}

export function ImageIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.5 17l4.5-4.5 3.5 3 3-2.5 4.5 4" />
  </>);
}

export function DocumentIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
    <path d="M14 3.5v5h5" />
  </>);
}

export function SheetIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M4 10h16M4 15h16M10 4v16" />
  </>);
}

export function ArchiveBoxIcon({ size = 15 }: IconProps) {
  return frame(size, <>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M10 4v6l2-1.5 2 1.5V4" />
  </>);
}

export function CheckCircleIcon({ size = 22 }: IconProps) {
  return frame(size, <>
    <circle cx="12" cy="12" r="9" />
    <path d="M7.8 12.4l2.9 2.9 5.5-6" />
  </>);
}

export function AlertCircleIcon({ size = 22 }: IconProps) {
  return frame(size, <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <path d="M12 16.4h.01" />
  </>);
}

export function ClockIcon({ size = 22 }: IconProps) {
  return frame(size, <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.4l3.4 2" />
  </>);
}

/** The reader with nothing in it: an open envelope with a page rising out of it. */
export function ReaderEmptyIcon({ size = 34 }: IconProps) {
  return frame(size, <>
    <path d="M3 9.5l9-6 9 6V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M3.5 10l8.5 5.6 8.5-5.6" />
  </>);
}

export function AttachmentIcon({ size = 13 }: IconProps) {
  return frame(size, <path d="M21 11.5l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />);
}

export function MailboxRoleIcon({ role, size }: { role: MailboxRole; size?: number }) {
  switch (role) {
    case 'inbox': return <InboxIcon size={size} />;
    case 'sent': return <SentIcon size={size} />;
    case 'drafts': return <DraftsIcon size={size} />;
    case 'archive': return <ArchiveIcon size={size} />;
    case 'trash': return <TrashIcon size={size} />;
    case 'spam': return <SpamIcon size={size} />;
    default: return <FolderIcon size={size} />;
  }
}

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

export function BackIcon({ size = 14 }: IconProps) {
  return frame(size, <path d="M15 5l-7 7 7 7" />);
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

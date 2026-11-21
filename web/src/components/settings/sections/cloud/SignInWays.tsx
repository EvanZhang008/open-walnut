/**
 * A browser sign-in code as two ways in, each under what it is for (2026-11-21 placement
 * review: the QR drew a laptop user's eye first, though a laptop types or opens a link):
 *
 *   On a computer   Open <address> and Type <code>, each on its own line, then Copy sign-in link
 *   On a phone      the QR for its camera; it signs in the phone's browser, never the app
 *   then            when it runs out, and any warning
 *
 * One shape for both codes Phones & Cloud shows: the tunnel's link (BrowserAccessGroup) and
 * the Same Wi-Fi code (WifiSignIn).
 */
import type { ReactNode } from 'react';
import { CopyButton } from '../../inputs/CopyButton';
import { PHONE_LINK_QR_SHOWN } from './phone-link-qr';
import '@/styles/browser-access.css';

interface Props {
  /** The address the other computer opens (a span its tests find). */
  open: ReactNode;
  /** The code it types there. */
  type: ReactNode;
  /** The sign-in link the computer opens, copied by the first button. */
  copy?: { text: string; testId: string };
  /** More buttons beside Copy. */
  actions?: ReactNode;
  /** The QR for a phone's camera, once drawn. */
  qr?: { src: string; alt: string; link: string; testId: string };
  /** When it runs out, and what to keep in mind. */
  note: ReactNode;
}

export function SignInWays({ open, type, copy, actions, qr, note }: Props) {
  return (
    <span className="sign-in-ways">
      <span className="sign-in-way" data-way="computer">
        <span className="sign-in-way-title">On a computer</span>
        {/* The address and the code each on a line of their own, where the eye finds them. */}
        <span className="sign-in-way-steps">
          <span className="sign-in-step"><span className="sign-in-step-key">Open</span>{open}</span>
          <span className="sign-in-step"><span className="sign-in-step-key">Type</span>{type}</span>
        </span>
        <span className="sign-in-way-body">
          {copy && <CopyButton text={copy.text} label="Copy sign-in link" bordered data-testid={copy.testId} />}
          {actions}
          <span className="sign-in-way-aside">Or copy the link and open it on that computer, not this one: opening it here uses the code up.</span>
        </span>
      </span>
      {qr && (
        <span className="sign-in-way" data-way="phone">
          <span className="sign-in-way-title">On a phone: scan to open its web browser</span>
          <span className="sign-in-way-body">
            <img
              className="browser-access-qr sign-in-way-qr"
              src={qr.src}
              alt={qr.alt}
              width={PHONE_LINK_QR_SHOWN}
              height={PHONE_LINK_QR_SHOWN}
              data-for={qr.link}
              data-testid={qr.testId}
            />
            <span>Signs you in to Walnut in the phone&apos;s browser, not the Walnut app.</span>
          </span>
        </span>
      )}
      <span className="browser-access-link-note">{note}</span>
    </span>
  );
}

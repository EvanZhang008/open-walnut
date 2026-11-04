import QRCode from 'qrcode';

/** How the phone link's QR code is drawn: twice the size it shows at (PHONE_LINK_QR_SHOWN), so it
 *  stays sharp on a Retina screen, with two modules of white around it for the camera. A test reads
 *  the same values to check, module by module, that the page shows the QR of the link it shows. */
export const PHONE_LINK_QR = { errorCorrectionLevel: 'M', width: 400, margin: 2 } as const;
export const PHONE_LINK_QR_SHOWN = 200;

/**
 * The QR code a phone's camera scans to open `link` (the phone link of BrowserAccessGroup):
 * a PNG data URL, or undefined when it cannot be drawn.
 */
export function phoneLinkQr(link: string): Promise<string | undefined> {
  return QRCode.toDataURL(link, PHONE_LINK_QR).catch(() => undefined);
}

/** The modules of `link`'s QR code, row by row ('1' dark, '0' light), and its size. */
export function phoneLinkQrModules(link: string): { size: number; bits: string } {
  const { modules } = QRCode.create(link, { errorCorrectionLevel: PHONE_LINK_QR.errorCorrectionLevel });
  let bits = '';
  for (let r = 0; r < modules.size; r++) for (let c = 0; c < modules.size; c++) bits += modules.get(r, c) ? '1' : '0';
  return { size: modules.size, bits };
}

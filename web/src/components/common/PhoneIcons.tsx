/**
 * SVG icons for the phone chrome. iOS draws some text glyphs (a play triangle,
 * a question mark ornament, a warning sign, pause) as color emoji, so the phone
 * layout never uses those characters as icons: it uses these. All are
 * monochrome (currentColor), decorative (aria-hidden: the button carries the
 * label) and drawn on a 24 x 24 grid.
 */
import type { ReactNode } from 'react';

export interface PhoneIconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 20, className, children, fill = 'none' }: PhoneIconProps & { children: ReactNode; fill?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function ChevronLeftIcon(p: PhoneIconProps) {
  return <Svg {...p}><path d="M15 5l-7 7 7 7" /></Svg>;
}

export function ChevronRightIcon(p: PhoneIconProps) {
  return <Svg {...p}><path d="M9 5l7 7-7 7" /></Svg>;
}

export function KebabVerticalIcon(p: PhoneIconProps) {
  return (
    <Svg {...p} fill="currentColor">
      <circle cx="12" cy="5" r="1.6" stroke="none" />
      <circle cx="12" cy="12" r="1.6" stroke="none" />
      <circle cx="12" cy="19" r="1.6" stroke="none" />
    </Svg>
  );
}

export function BellOutlineIcon(p: PhoneIconProps) {
  return (
    <Svg {...p}>
      <path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 004 0" />
    </Svg>
  );
}

export function AlertCircleIcon(p: PhoneIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5v.01" />
    </Svg>
  );
}

export function PlayGlyphIcon(p: PhoneIconProps) {
  return <Svg {...p} fill="currentColor"><path d="M8 5.5v13l10.5-6.5z" /></Svg>;
}

export function PauseGlyphIcon(p: PhoneIconProps) {
  return (
    <Svg {...p} fill="currentColor">
      <rect x="6.5" y="5.5" width="3.5" height="13" rx="1" stroke="none" />
      <rect x="14" y="5.5" width="3.5" height="13" rx="1" stroke="none" />
    </Svg>
  );
}

export function QuestionCircleIcon(p: PhoneIconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 014.8 1c0 1.7-2.4 2.2-2.4 3.7" />
      <path d="M12 17v.01" />
    </Svg>
  );
}

export function WarningTriangleIcon(p: PhoneIconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5v.01" />
    </Svg>
  );
}

export function ArrowUpRightIcon(p: PhoneIconProps) {
  return <Svg {...p}><path d="M7 17L17 7" /><path d="M9 7h8v8" /></Svg>;
}

export function SearchGlyphIcon(p: PhoneIconProps) {
  return <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></Svg>;
}

export function MenuLinesIcon(p: PhoneIconProps) {
  return <Svg {...p}><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></Svg>;
}

export function CloseGlyphIcon(p: PhoneIconProps) {
  return <Svg {...p}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></Svg>;
}

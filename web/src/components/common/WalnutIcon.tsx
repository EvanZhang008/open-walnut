/**
 * The Walnut app icon (`/walnut-icon.png`): ONE component for every place that shows it (the
 * sidebar's Walnut button, the new task draft's Quick chat tile and block, a letter's origin
 * mark, the unpaired notice). `alt` is '' where words beside it already say "Walnut".
 */
export function WalnutIcon({ size, className, alt = '' }: { size?: number; className?: string; alt?: string }) {
  return (
    <img
      src="/walnut-icon.png"
      alt={alt}
      {...(alt ? {} : { 'aria-hidden': true })}
      className={className}
      {...(size ? { width: size, height: size } : {})}
    />
  );
}

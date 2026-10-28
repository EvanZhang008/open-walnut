import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { keepInBox } from './plugin-bounds'
import '@/styles/plugin-bounds.css'

/** The box a plugin's App or page renders in: it draws inside it and nowhere else (plugin-bounds.ts). */
export function PluginBounds({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  // Before the plugin's own effects run, so one that opens a dialog at once is caught opening.
  useLayoutEffect(() => (ref.current ? keepInBox(ref.current) : undefined), [])
  return (
    <div ref={ref} className={className ? `${className} plugin-bounds` : 'plugin-bounds'} {...rest}>
      {children}
    </div>
  )
}

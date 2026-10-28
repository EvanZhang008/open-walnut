import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { PluginBoxContext } from '@/contexts/PluginBoxContext'
import { keepInBox } from './plugin-bounds'
import '@/styles/plugin-bounds.css'

/** The box a plugin's App or page renders in: it draws inside it and nowhere else (plugin-bounds.ts). */
export function PluginBounds({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  // A layout effect, so it watches before the plugin's own passive effects run; what the plugin
  // opened in its layout effects, which run before ours, keepInBox finds open when it starts.
  useLayoutEffect(() => (ref.current ? keepInBox(ref.current) : undefined), [])
  return (
    <div ref={ref} className={className ? `${className} plugin-bounds` : 'plugin-bounds'} {...rest}>
      <PluginBoxContext.Provider value={true}>{children}</PluginBoxContext.Provider>
    </div>
  )
}

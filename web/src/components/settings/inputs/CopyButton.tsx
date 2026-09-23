/** `Copy` -> `Copied` for 1.5s. Width reserved for the longer label. */
import { useEffect, useRef, useState } from 'react'
import { log } from '@/utils/log'
import { SettingsButton } from './SettingsButton'

export const COPIED_MS = 1500

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Fallback for hosts without the async clipboard (older WebKit shells).
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    document.execCommand('copy')
  } finally {
    area.remove()
  }
}

export function CopyButton({ text, 'data-testid': testId }: { text: string; 'data-testid'?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const onClick = () => {
    writeClipboard(text).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      },
      (err: unknown) => log.warn('settings', 'copy failed', { message: String(err) }),
    )
  }
  return (
    <SettingsButton variant="text" reserve={['Copy', 'Copied']} onClick={onClick} data-testid={testId}>
      {copied ? 'Copied' : 'Copy'}
    </SettingsButton>
  )
}

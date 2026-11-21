/** Settings' Copy: the one shared Copy button (components/common/CopyButton.tsx), small. */
import { CopyButton as SharedCopyButton } from '@/components/common/CopyButton'

export { COPIED_MS } from '@/components/common/CopyButton'

const KIND = { text: 'link', default: 'default', primary: 'primary' } as const

export function CopyButton({ text, variant = 'text', label = 'Copy', bordered = false, 'data-testid': testId }: {
  text: string
  variant?: 'text' | 'default' | 'primary'
  label?: string
  /** A key with a fill, to sit among other keys (the same as variant "default"). */
  bordered?: boolean
  'data-testid'?: string
}) {
  return <SharedCopyButton text={text} label={label} kind={KIND[bordered ? 'default' : variant]} data-testid={testId} />
}

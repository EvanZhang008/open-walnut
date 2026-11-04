/**
 * A backup secret (a bucket's secret access key, a Google client secret).
 *
 * The server never sends a saved one back, only its mask; the field then reads
 * "Saved (...NEVG)". Typing replaces it; an emptied field keeps the saved one.
 */
import { SecretInput } from '../../inputs/SecretInput'

const isMask = (v: string): boolean => v.includes('•')

export function KeyInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const masked = isMask(value)
  const tail = masked ? value.replace(/•/g, '') : ''
  return (
    <SecretInput
      id={id}
      value={masked ? '' : value}
      placeholder={masked ? (tail ? `Saved (...${tail})` : 'Saved') : undefined}
      onChange={(v) => onChange(v === '' && masked ? value : v)}
    />
  )
}

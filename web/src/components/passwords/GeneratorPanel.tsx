/**
 * The password generator: random characters or words, live preview, Use / Copy.
 * Runs in the page (crypto.getRandomValues); the generator choices are kept like any
 * other view choice, never the password.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_PASSPHRASE, DEFAULT_PASSWORD, MAX_LENGTH, MAX_WORDS, MIN_LENGTH, MIN_WORDS, generate, generatorBits,
  type GeneratorOptions, type PassphraseOptions, type PasswordOptions,
} from '../../../../src/core/vault/generator'
import { usePageView } from '@/utils/view-memory'
import { copySecret } from '@/api/vault'
import { CopyIcon, DiceIcon, CheckIcon } from './pw-icons'

function isOptions(v: unknown): v is GeneratorOptions {
  const o = v as Partial<GeneratorOptions> | null
  return !!o && (o.kind === 'random' || o.kind === 'words')
}

export function GeneratorPanel({ onUse }: { onUse?: (password: string) => void }) {
  const [opts, setOpts] = usePageView<GeneratorOptions>('passwords', 'generator', DEFAULT_PASSWORD, isOptions)
  const [value, setValue] = useState('')
  const [copied, setCopied] = useState(false)
  const again = useCallback(() => { setValue(generate(opts)); setCopied(false) }, [opts])
  useEffect(() => { again() }, [again])

  const random = opts.kind === 'random' ? opts : null
  const words = opts.kind === 'words' ? opts : null
  const setR = (p: Partial<PasswordOptions>) => setOpts({ ...(random ?? DEFAULT_PASSWORD), ...p })
  const setW = (p: Partial<PassphraseOptions>) => setOpts({ ...(words ?? DEFAULT_PASSPHRASE), ...p })
  const bits = Math.round(generatorBits(opts))

  return (
    <div className="pw-gen" data-testid="pw-generator">
      <div className="pw-gen-out">
        <code className="pw-gen-value" data-testid="pw-gen-value">{value}</code>
        <button type="button" className="pw-icon-btn" title="Generate another" aria-label="Generate another" onClick={again}><DiceIcon /></button>
      </div>
      <div className="pw-gen-bits">{bits} bits · {bits >= 80 ? 'very strong' : bits >= 60 ? 'strong' : 'fair'}</div>
      <div className="pw-seg" role="tablist">
        <button type="button" role="tab" aria-selected={!!random} className={random ? 'on' : ''} onClick={() => setOpts(random ?? DEFAULT_PASSWORD)}>Random</button>
        <button type="button" role="tab" aria-selected={!!words} className={words ? 'on' : ''} onClick={() => setOpts(words ?? DEFAULT_PASSPHRASE)}>Words</button>
      </div>
      {random && (
        <>
          <label className="pw-gen-row">
            <span>Length</span>
            <input type="range" min={MIN_LENGTH} max={64} value={Math.min(random.length, 64)} onChange={(e) => setR({ length: Number(e.target.value) })} aria-label="Length" />
            <input data-no-draft="number" type="number" className="pw-gen-num" min={MIN_LENGTH} max={MAX_LENGTH} value={random.length} onChange={(e) => setR({ length: Number(e.target.value) })} aria-label="Length value" />
          </label>
          <div className="pw-gen-checks">
            {([['upper', 'A-Z'], ['lower', 'a-z'], ['digits', '0-9'], ['symbols', '!@#']] as const).map(([k, label]) => (
              <label key={k} className="pw-chip-check"><input type="checkbox" checked={random[k]} onChange={(e) => setR({ [k]: e.target.checked })} />{label}</label>
            ))}
            <label className="pw-chip-check"><input type="checkbox" checked={random.avoidAmbiguous} onChange={(e) => setR({ avoidAmbiguous: e.target.checked })} />No look-alikes</label>
          </div>
        </>
      )}
      {words && (
        <>
          <label className="pw-gen-row">
            <span>Words</span>
            <input type="range" min={MIN_WORDS} max={MAX_WORDS} value={words.words} onChange={(e) => setW({ words: Number(e.target.value) })} aria-label="Words" />
            <span className="pw-gen-num">{words.words}</span>
          </label>
          <div className="pw-gen-checks">
            <label className="pw-chip-check"><input type="checkbox" checked={words.capitalize} onChange={(e) => setW({ capitalize: e.target.checked })} />Capitalize</label>
            <label className="pw-chip-check"><input type="checkbox" checked={words.number} onChange={(e) => setW({ number: e.target.checked })} />Add a digit</label>
            <span className="pw-sep" role="group" aria-label="Separator">
              {[['-', '-'], ['.', '.'], ['_', '_'], [' ', 'space']].map(([sep, label]) => (
                <button key={label} type="button" className={words.separator === sep ? 'on' : ''} aria-pressed={words.separator === sep} onClick={() => setW({ separator: sep })}>{label}</button>
              ))}
            </span>
          </div>
        </>
      )}
      <div className="pw-gen-actions">
        <button type="button" className="pw-btn" onClick={() => { void copySecret(value).then(() => setCopied(true)) }}>
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy'}
        </button>
        {onUse && <button type="button" className="pw-btn pw-btn-primary" onClick={() => onUse(value)}>Use this password</button>}
      </div>
    </div>
  )
}

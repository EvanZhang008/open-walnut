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
import { DiceIcon } from './pw-icons'
import { CopyButton } from '@/components/common/CopyButton'
import { Checkbox, SegmentedControl, type SegmentedOption } from '@/components/controls'

const KIND_OPTIONS: ReadonlyArray<SegmentedOption<GeneratorOptions['kind']>> = [
  { value: 'random', label: 'Random' },
  { value: 'words', label: 'Words' },
]
const SEPARATOR_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: '-', label: '-' }, { value: '.', label: '.' }, { value: '_', label: '_' }, { value: ' ', label: 'space' },
]

function isOptions(v: unknown): v is GeneratorOptions {
  const o = v as Partial<GeneratorOptions> | null
  return !!o && (o.kind === 'random' || o.kind === 'words')
}

export function GeneratorPanel({ onUse }: { onUse?: (password: string) => void }) {
  const [opts, setOpts] = usePageView<GeneratorOptions>('passwords', 'generator', DEFAULT_PASSWORD, isOptions)
  const [value, setValue] = useState('')
  const again = useCallback(() => { setValue(generate(opts)) }, [opts])
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
        <button type="button" className="btn btn-icon" title="Generate another" aria-label="Generate another" onClick={again}><DiceIcon /></button>
      </div>
      <div className="pw-gen-bits">{bits} bits · {bits >= 80 ? 'very strong' : bits >= 60 ? 'strong' : 'fair'}</div>
      <SegmentedControl<GeneratorOptions['kind']>
        aria-label="Kind of password"
        className="pw-gen-kind"
        value={opts.kind}
        options={KIND_OPTIONS}
        onChange={(k) => setOpts(k === 'random' ? DEFAULT_PASSWORD : DEFAULT_PASSPHRASE)}
      />
      {random && (
        <>
          <label className="pw-gen-row">
            <span>Length</span>
            <input type="range" min={MIN_LENGTH} max={64} value={Math.min(random.length, 64)} onChange={(e) => setR({ length: Number(e.target.value) })} aria-label="Length" />
            <input data-no-draft="number" type="number" className="pw-gen-num is-sm" min={MIN_LENGTH} max={MAX_LENGTH} value={random.length} onChange={(e) => setR({ length: Number(e.target.value) })} aria-label="Length value" />
          </label>
          <div className="pw-gen-checks">
            {([['upper', 'A-Z'], ['lower', 'a-z'], ['digits', '0-9'], ['symbols', '!@#']] as const).map(([k, label]) => (
              <Checkbox key={k} checked={random[k]} onChange={(on) => setR({ [k]: on })} label={label} />
            ))}
            <Checkbox checked={random.avoidAmbiguous} onChange={(on) => setR({ avoidAmbiguous: on })} label="No look-alikes" />{/* empty-state-ok: checkbox label */}
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
            <Checkbox checked={words.capitalize} onChange={(on) => setW({ capitalize: on })} label="Capitalize" />
            <Checkbox checked={words.number} onChange={(on) => setW({ number: on })} label="Add a digit" />
            <SegmentedControl aria-label="Separator" value={words.separator} options={SEPARATOR_OPTIONS} onChange={(sep) => setW({ separator: sep })} />
          </div>
        </>
      )}
      <div className="pw-gen-actions">
        <CopyButton key={value} text={value} icon write={copySecret} />
        {onUse && <button type="button" className="btn btn-sm btn-primary" onClick={() => onUse(value)}>Use this password</button>}
      </div>
    </div>
  )
}

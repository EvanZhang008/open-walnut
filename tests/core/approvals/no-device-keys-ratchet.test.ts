/**
 * Approvals have no device keys and no signatures, and Approve is never a dead button (2026-11-21,
 * the user, on a grey Approve on the phone: "为什么要签名钥匙？... 只要我这个手机连到了这里面，或者其他的
 * device ... 就可以签呢"). The one rule is who answers: a person, on any device they are signed in on
 * (routes/person-caller.ts); each answer is bound to the request's digest, used once and recorded.
 *
 * The class of the bug: an Approve a signed-in device could not press (a key that phone did not hold,
 * Face ID required where no key was enrolled, Passwords locked in that window). This reads every
 * source file of the server, the web console and its browser panel, the Mac app and the iPhone app,
 * so a new member fails here:
 *  - a device key or a signature check coming back (a keys file or route, a verifier, the Secure
 *    Enclave or Face ID in approval code, a removed module);
 *  - an older record's fields read anywhere but the few places that take them and ignore them;
 *  - an Approve button disabled for anything but an answer already on its way.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const ROOTS = ['src', 'web/src', 'desktop', 'ios-native/Walnut', 'packages/browser-extension/src']
const EXT = /\.(ts|tsx|mts|js|mjs|swift|sh)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walk(rel, out)
    else if (EXT.test(e.name)) out.push(rel)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r))
const text = new Map(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]))
/** Files under those gates that answer no Walnut approval, each with why. */
const NOT_APPROVALS: Record<string, string> = {
  'src/core/vault/passkey-confirm-keys.ts': "the vault's passkey confirm: the browser's own WebAuthn proves the person before a stored passkey signs in to a site (like Face ID unlocking Passwords), never an answer to a Walnut approval",
}
/** Approval code: a file named for approvals, or one of the gates that asks for them. */
const approvalCode = files.filter((f) => !NOT_APPROVALS[f] && (/approv/i.test(f) || /^src\/core\/(vault|browser-control)\//.test(f) || /^src\/web\/(routes\/(vault-agent|browser)-v1|v1-forward\/)/.test(f)))

function hits(list: string[], re: RegExp): string[] {
  const out: string[] = []
  for (const f of list) {
    const lines = text.get(f)!.split('\n')
    lines.forEach((l, i) => { if (re.test(l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 140)}`) })
  }
  return out
}

describe('no device keys and no signatures in approvals', () => {
  it('reads the sources it guards (the walk still finds them)', () => {
    for (const f of ['src/core/approvals/store.ts', 'src/web/routes/approvals-v1.ts', 'web/src/components/approvals/ApprovalPrompts.tsx',
      'ios-native/Walnut/Views/Approvals/ApprovalSheet.swift', 'ios-native/Walnut/Stores/ApprovalCenter.swift', 'desktop/main.swift']) {
      expect(files, f).toContain(f)
    }
    expect(approvalCode.length).toBeGreaterThan(20)
  })

  it('the removed modules stay removed', () => {
    for (const f of ['src/core/approvals/keys.ts', 'src/core/approvals/mac-app-proof.ts', 'src/core/approvals/phone-app.ts',
      'src/core/approvals/signer-words.ts', 'src/core/approvals/biometric-fence.ts', 'src/web/v1-forward/forwarded-device.ts',
      'web/src/components/approvals/touch-id-bridge.ts', 'web/src/components/approvals/ApprovalUnlock.tsx',
      'desktop/ApprovalBridge.swift', 'desktop/ApprovalHome.swift', 'ios-native/Walnut/Core/ApprovalSigning.swift']) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(false)
    }
  })

  it('no keys file or route, no signature verifier, no Secure Enclave or Face ID in approval code', () => {
    expect(hits(files, /approvals\/keys|approvalKeys|enrollApprovalKey|activeKeys\(/)).toEqual([])
    expect(hits(approvalCode, /verifySignature|crypto\.verify\(|createVerify\(|keyIdOf\(|signatureOk|answerMessage\(digest/)).toEqual([])
    expect(hits(approvalCode.filter((f) => f.endsWith('.swift')), /SecKeyCreateSignature|kSecAttrTokenIDSecureEnclave|SecureEnclave|LAContext|evaluatePolicy|walnutApproval/)).toEqual([])
    // The web console never asks the Mac app to sign (its Touch ID bridge is gone).
    expect(hits(files.filter((f) => f.startsWith('web/src/')), /messageHandlers\.walnutApproval|walnutApprovalSign/)).toEqual([])
  })

  it("an older record's fields are read only where they are taken and ignored", () => {
    // Inputs an older asker still sends (the Git gate pins two keys): accepted by the op and the route, never used.
    expect(hits(files, /signing_?[kK]ey_?[iI]ds?\b|signingKeyIds?\b/).map((h) => h.split(':')[0]).filter((f) => !['src/ops/approvals.ts', 'src/web/routes/approvals-v1.ts'].includes(f!))).toEqual([])
    // Asks an older Walnut left pending (enroll a key, remove one, turn approvals off with a signature):
    // the store withdraws them at boot (store.ts withdrawDeviceKeyAsks), and nothing else reads them.
    expect(hits(files, /enrollsKey|removesKey|turnsAskMeOff/).map((h) => h.split(':')[0]).filter((f) => !['src/core/approvals/store.ts', 'src/core/approvals/types.ts'].includes(f!))).toEqual([])
    // A Passwords guard on an approval (unlock in this window, or a signed proof) is gone.
    expect(hits(approvalCode, /vault_unlock_needed|proof_needed|biometric_required|signature_needed|signer_too_new|first_key_from_phone|guard: '(vault|vault-sensitive|person)'/)).toEqual([])
  })
})

describe('Approve is never a dead button', () => {
  it('web: every Approve is disabled only while an answer is on its way, and no "approve elsewhere" or "unlock to approve" stands in for it', () => {
    const web = files.filter((f) => f.startsWith('web/src/') && f.endsWith('.tsx'))
    const approves: string[] = []
    for (const f of web) {
      for (const m of text.get(f)!.matchAll(/<button\b[^>]*approval-btn-approve[^>]*>/gs)) {
        approves.push(f)
        const disabled = /disabled=\{([^}]*)\}/.exec(m[0])?.[1]?.trim()
        expect(disabled, `${f}: ${m[0].slice(0, 160)}`).toBe('!!working')
      }
    }
    expect(approves).toContain('web/src/components/approvals/ApprovalPrompts.tsx')
    expect(hits(web, /approval-approve-elsewhere|approval-unlock-to-approve|approval-unlock\b|approveKind|noApproveReason|unlockApproves/)).toEqual([])
  })

  it('iPhone: the sheet disables its buttons only while an answer is on its way, and has no blocked state', () => {
    const sheet = text.get('ios-native/Walnut/Views/Approvals/ApprovalSheet.swift')!
    const disabled = [...sheet.matchAll(/\.disabled\(([^)]*)\)/g)].map((m) => m[1]!.trim())
    expect(disabled.length).toBeGreaterThan(0)
    for (const d of disabled) expect(d).toBe('working != nil')
    expect(sheet).toContain('accessibilityIdentifier("approval.approve")')
    const ios = files.filter((f) => f.startsWith('ios-native/') && /approv/i.test(f))
    expect(hits(ios, /approval\.blocked|approve-elsewhere|canSign|signerMissing|\.blocked\(/)).toEqual([])
  })
})

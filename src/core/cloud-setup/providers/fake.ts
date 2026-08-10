/**
 * Fake provisioning driver, registered ONLY when WALNUT_CLOUD_SETUP_FAKE=1.
 *
 * Exists so the Playwright fixture can exercise the wizard's real flow —
 * providers → configure → start → a job that reaches `provision` → cancel —
 * without an AWS account or a CDK deploy. It deliberately does NOT fake the rest
 * of the sequence: `await-server` polls a real HTTP endpoint on a real box, and
 * a claim needs a real second Walnut, so any "success" it manufactured would
 * prove nothing the PR2 integration test doesn't already prove for real.
 *
 * So `createVM` blocks (cooperatively, honouring cancellation) instead of
 * returning a fake origin: the browser test asserts the job PARKS at provision
 * and that cancelling from the UI tears it down.
 */

import type {
  CloudProviderDriver,
  CreateVMParams,
  CreateVMResult,
  DetectCredsResult,
  DriverInstructions,
  InstructionsParams,
} from './types.js'

/** Env flag, read at import time by the registry. */
export const FAKE_DRIVER_ENV = 'WALNUT_CLOUD_SETUP_FAKE'

async function detectCreds(): Promise<DetectCredsResult> {
  return {
    available: true,
    detail: 'Fake provisioning driver (test fixture) — creates nothing.',
    needs: 'nothing',
  }
}

/**
 * Parks forever, checking for cancellation. The runner's own cancel path aborts
 * the job; this just has to not resolve and not spin the CPU.
 */
async function createVM(_params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult> {
  onLog('fake driver: pretending to provision — this never completes by design')
  await new Promise<void>((_resolve, reject) => {
    const timer = setInterval(() => { /* keep the handle alive without busy-waiting */ }, 60_000)
    timer.unref?.()
    // 10 minutes is far beyond any browser spec's patience; if a run ever hits
    // it, fail loudly rather than hanging the fixture's shutdown.
    const cap = setTimeout(() => {
      clearInterval(timer)
      reject(new Error('fake driver: provision window elapsed'))
    }, 10 * 60_000)
    cap.unref?.()
  })
  throw new Error('unreachable')
}

function instructions(params: InstructionsParams): DriverInstructions {
  return {
    steps: [
      'Fake provider (test fixture): nothing to do on any real console.',
      `Target hostname: ${params.domain}`,
    ],
    userData: params.userData,
  }
}

export const fakeDriver: CloudProviderDriver = {
  // Its own id, never a shipped provider's slot. It originally borrowed 'gcp'
  // while that was an empty placeholder — then the real gcp driver landed and
  // the registry's Map.set silently REPLACED it in fixture mode, making the
  // real GCP card unreachable from every browser test. A registry guard in
  // index.ts now makes that collision loud instead of silent.
  id: 'fake',
  label: 'Fake provider (test fixture)',
  costHint: 'free — provisions nothing',
  detectCreds,
  createVM,
  instructions,
}

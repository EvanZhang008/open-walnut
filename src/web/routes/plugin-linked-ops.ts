/**
 * Linked dev checkouts as ONE injectable unit, shared by the plugin-runtime router (check /
 * update / registry) and the plugin-updates router (the batch status GET). server.ts builds
 * one object and hands it to both, so a test can swap git out once.
 *
 * Behind an interface so route tests never touch git: the real implementation is imported
 * lazily, keeping git-sync (and everything it drags in) off the routers' import path.
 */
import fsp from 'node:fs/promises'
import type {
  LinkedCheckoutInfo,
  LinkedCheckoutListing,
  LinkedCheckoutStatus,
  LinkedGitOptions,
  LinkedUpdateResult,
} from '../../core/plugins/linked-checkout.js'
import { linkedRowKey } from '../../core/plugins/update-status.js'

export interface LinkedCheckoutOps {
  detect(pluginId: string, pluginDir?: string): Promise<LinkedCheckoutInfo | null>
  list(): Promise<Map<string, LinkedCheckoutInfo>>
  /** `list` plus the link names its budget skipped, so a row can say "not scanned". */
  listDetailed?(): Promise<LinkedCheckoutListing>
  check(info: LinkedCheckoutInfo, opts?: LinkedGitOptions): Promise<LinkedCheckoutStatus>
  update(info: LinkedCheckoutInfo): Promise<LinkedUpdateResult>
}

/** The real unit, every function imported at call time so git stays off the import path until a caller asks. */
export function defaultLinkedCheckoutOps(): LinkedCheckoutOps {
  return {
    detect: async (pluginId, pluginDir) => {
      const { detectLinkedCheckout } = await import('../../core/plugins/linked-checkout.js')
      return detectLinkedCheckout(pluginId, pluginDir)
    },
    list: async () => {
      const { listLinkedCheckouts } = await import('../../core/plugins/linked-checkout.js')
      return listLinkedCheckouts()
    },
    listDetailed: async () => {
      const { listLinkedCheckoutsDetailed } = await import('../../core/plugins/linked-checkout.js')
      return listLinkedCheckoutsDetailed()
    },
    check: async (info, opts) => {
      const { checkLinkedCheckout } = await import('../../core/plugins/linked-checkout.js')
      return checkLinkedCheckout(info, opts)
    },
    update: async (info) => {
      const { updateLinkedCheckout } = await import('../../core/plugins/linked-checkout.js')
      return updateLinkedCheckout(info)
    },
  }
}

/**
 * What a replica says about a linked checkout. These act on a git work tree that only
 * exists on the Mac, and the plugin-manage relay carries a fixed set of actions, so
 * relaying through one of those would be a lie about what ran. Byte-identical to the
 * client's copy in web/src/components/settings/plugin-update-view.ts.
 */
export const CLOUD_LINKED_NOTE = 'Linked plugin checkouts live on your Mac. Open Settings → Plugins there to check or update one.'

/** An update that outlives this many ms answers 504; git may still finish on its own. */
export const LINKED_UPDATE_DEADLINE_MS = 60_000
export const UPDATE_TIMEOUT_MESSAGE = 'Update timed out after 60 s. The checkout was not changed unless git finished on its own; check again.'

/** The cache key for a linked checkout: by realpath, so two links into one repo share a row. */
export async function linkedRowKeyOf(info: LinkedCheckoutInfo): Promise<string> {
  return linkedRowKey(await fsp.realpath(info.checkout).catch(() => info.checkout))
}

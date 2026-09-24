/**
 * Error wording the skill store and its two routers share. A leaf module: the
 * v1 router loads the store lazily and must not pull it in to map an error.
 */

/**
 * In every message about a shipped skill on a package the server cannot write
 * (the cloud companion: root owns the code tree). Both routers answer it 409.
 */
export const SKILL_READ_ONLY_INSTALL = 'ships with Walnut and this install is read-only'

export const SHIPPED_SKILL_READ_ONLY_EDIT =
  `This skill ${SKILL_READ_ONLY_INSTALL}. Edit it on your primary Mac instead.`

export const SHIPPED_SKILL_READ_ONLY_DELETE =
  `This skill ${SKILL_READ_ONLY_INSTALL}, so it cannot be removed here. Disable it instead.`

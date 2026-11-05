/**
 * The name the save bar suggests for a new login (pure, unit tested): the site's name, and when
 * this site already has a login of that name, one that tells the two apart, with the username
 * ("Lab Shop (newuser@lab.test)"), else a number ("Lab Shop 2").
 */
export function distinctName(base: string, username: string | undefined, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()))
  const free = (n: string) => !used.has(n.trim().toLowerCase())
  const name = base.trim()
  if (!name || free(name)) return name
  const user = username?.trim()
  if (user) {
    const withUser = `${name} (${user.length > 40 ? user.split('@')[0] : user})`
    if (free(withUser)) return withUser
  }
  for (let i = 2; i < 100; i++) if (free(`${name} ${i}`)) return `${name} ${i}`
  return name
}

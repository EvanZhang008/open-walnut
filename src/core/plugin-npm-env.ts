/**
 * The npm network settings bun does not read, handed to it the way it does.
 *
 * Plugin installs run `bun info` and `bun add` (plugin-npm-install.ts). bun reads
 * the registry, auth and `cafile` from ~/.npmrc, but not `https-proxy`, `proxy`,
 * `noproxy` or `strict-ssl` (checked against bun 1.4.4): it takes those only from
 * the environment (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, NODE_TLS_REJECT_UNAUTHORIZED).
 * A server started by launchd has no shell env, so a user whose npm worked through
 * a proxy set in ~/.npmrc would see every plugin install fail. When the env does
 * not already name one, the value comes from the npmrc npm itself would read.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Env = NodeJS.ProcessEnv

/** Parse an npmrc: `key = value` lines, `;` and `#` comments, `${VAR}` from env. */
export function parseNpmrc(text: string, env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    // npm replaces ${NAME} with the variable; a name the env does not hold leaves no usable value.
    let unset = false
    value = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
      const v = env[name]
      if (v === undefined) unset = true
      return v ?? ''
    })
    if (!unset) out[key] = value
  }
  return out
}

/** A value npm treats as no setting. */
const isUnset = (v: string | undefined): v is undefined => v === undefined || v === '' || v === 'null' || v === 'false'

/** An env var, read case-insensitively as npm and bun do for these. */
function envOf(env: Env, name: string): string | undefined {
  return env[name] ?? env[name.toLowerCase()]
}

/** The npm config npm would use: ~/.npmrc (or NPM_CONFIG_USERCONFIG), then npm_config_* env over it. */
export function npmNetworkConfig(env: Env = process.env, home: string = os.homedir()): Record<string, string> {
  const file = envOf(env, 'NPM_CONFIG_USERCONFIG') ?? path.join(home, '.npmrc')
  let config: Record<string, string> = {}
  try {
    config = parseNpmrc(fs.readFileSync(file, 'utf8'), env)
  } catch {
    // No npmrc: nothing to hand on.
  }
  for (const key of ['https-proxy', 'proxy', 'noproxy', 'strict-ssl']) {
    const fromEnv = envOf(env, `NPM_CONFIG_${key.replace('-', '_').toUpperCase()}`)
    if (fromEnv !== undefined) config[key] = fromEnv
  }
  return config
}

/**
 * The env vars that give bun what npm's config says about the network, for the
 * ones the env does not set already (the env wins, as it does for npm).
 */
export function npmrcNetworkEnv(env: Env = process.env, home: string = os.homedir()): Record<string, string> {
  const c = npmNetworkConfig(env, home)
  const out: Record<string, string> = {}
  const httpsProxy = !isUnset(c['https-proxy']) ? c['https-proxy'] : !isUnset(c.proxy) ? c.proxy : undefined
  if (httpsProxy && envOf(env, 'HTTPS_PROXY') === undefined) out.HTTPS_PROXY = httpsProxy
  if (!isUnset(c.proxy) && envOf(env, 'HTTP_PROXY') === undefined) out.HTTP_PROXY = c.proxy
  const noProxy = c.noproxy ?? c['no-proxy']
  if (!isUnset(noProxy) && envOf(env, 'NO_PROXY') === undefined) out.NO_PROXY = noProxy
  // strict-ssl=false: the user told npm to accept any certificate; bun takes Node's variable for it.
  if (c['strict-ssl'] === 'false' && env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) out.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return out
}

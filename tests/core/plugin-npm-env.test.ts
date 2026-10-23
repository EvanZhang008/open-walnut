/**
 * The npm network settings handed to bun for plugin installs (src/core/plugin-npm-env.ts):
 * bun reads no proxy and no strict-ssl from ~/.npmrc, and a server under launchd
 * has no shell env, so a user whose npm worked through an npmrc proxy would fail
 * every plugin install. A real bun through a real proxy is in plugin-npm-install-bun.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { npmNetworkConfig, npmrcNetworkEnv, parseNpmrc } from '../../src/core/plugin-npm-env.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-npmrc-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function home(npmrc: string | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'home-'))
  if (npmrc !== null) fs.writeFileSync(path.join(dir, '.npmrc'), npmrc)
  return dir
}

describe('parseNpmrc', () => {
  it('reads key = value lines, skips comments, unquotes, and fills ${VAR} from the env', () => {
    const text = [
      '; a comment', '# another', '',
      'https-proxy = http://proxy.example:3128',
      'proxy="http://plain.example:8080"',
      'noproxy=localhost,.internal.example',
      '//registry.example/:_authToken=${REG_TOKEN}',
      'strict-ssl=false',
      'cafile=${MISSING_VAR}/ca.pem',
      'not a setting',
    ].join('\n')
    expect(parseNpmrc(text, { REG_TOKEN: 't0k3n' })).toEqual({
      'https-proxy': 'http://proxy.example:3128',
      proxy: 'http://plain.example:8080',
      noproxy: 'localhost,.internal.example',
      '//registry.example/:_authToken': 't0k3n',
      'strict-ssl': 'false',
    })
  })
})

describe('npmrcNetworkEnv', () => {
  it('turns the npmrc proxies and strict-ssl=false into the env vars bun reads', () => {
    const h = home('https-proxy=http://proxy.example:3128\nproxy=http://plain.example:8080\nnoproxy=localhost\nstrict-ssl=false\n')
    expect(npmrcNetworkEnv({}, h)).toEqual({
      HTTPS_PROXY: 'http://proxy.example:3128',
      HTTP_PROXY: 'http://plain.example:8080',
      NO_PROXY: 'localhost',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    })
  })

  it('uses proxy for https too when that is all the npmrc sets', () => {
    expect(npmrcNetworkEnv({}, home('proxy=http://plain.example:8080\n'))).toEqual({
      HTTPS_PROXY: 'http://plain.example:8080', HTTP_PROXY: 'http://plain.example:8080',
    })
  })

  it('leaves what the env already sets, in either case, as npm does', () => {
    const h = home('https-proxy=http://proxy.example:3128\nproxy=http://plain.example:8080\nnoproxy=localhost\nstrict-ssl=false\n')
    expect(npmrcNetworkEnv({ https_proxy: 'http://mine:1', HTTP_PROXY: 'http://mine:2', no_proxy: '*', NODE_TLS_REJECT_UNAUTHORIZED: '1' }, h)).toEqual({})
  })

  it('takes npm_config_* over the file, and another file from NPM_CONFIG_USERCONFIG', () => {
    const h = home('https-proxy=http://from-home:1\n')
    const other = path.join(tmp, 'other-npmrc')
    fs.writeFileSync(other, 'https-proxy=http://from-userconfig:2\nstrict-ssl=true\n')
    expect(npmNetworkConfig({ npm_config_userconfig: other }, h)['https-proxy']).toBe('http://from-userconfig:2')
    expect(npmrcNetworkEnv({ NPM_CONFIG_USERCONFIG: other, npm_config_https_proxy: 'http://from-env:3' }, h)).toEqual({ HTTPS_PROXY: 'http://from-env:3' })
  })

  it('hands on nothing without an npmrc, or with settings npm reads as none', () => {
    expect(npmrcNetworkEnv({}, home(null))).toEqual({})
    expect(npmrcNetworkEnv({}, home('proxy=null\nhttps-proxy=\nstrict-ssl=true\n'))).toEqual({})
  })
})

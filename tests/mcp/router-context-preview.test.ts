import { expect, it, vi } from 'vitest';
import '../../src/ops/router.js';
import { getOp } from '../../src/ops/registry.js';

it('the router_context op always asks for bounded evidence, regardless of caller input', async () => {
  const call = vi.fn(async (_method: string, _path: string) => ({ body: { text: 'Preview' } }));
  const result = await getOp('router_context')!.handler!({
    kind: 'mail', account: 'desk@example.invalid', message: 'INBOX:1:10', version: 'v1', preview: '0',
  }, call);
  // The body is the sender's: it comes back inside the outside-data envelope.
  expect(result).toMatchObject({ external_content: { trust: 'untrusted', data: { body: { text: 'Preview' } } } });
  expect(result).not.toHaveProperty('body');
  const [method, path] = call.mock.calls[0] as unknown as [string, string];
  expect(method).toBe('GET');
  const url = new URL(path, 'https://example.invalid');
  expect(url.pathname).toBe('/router/context');
  expect(Object.fromEntries(url.searchParams)).toEqual({ preview: '1', kind: 'mail', account: 'desk@example.invalid', message: 'INBOX:1:10', version: 'v1' });
});

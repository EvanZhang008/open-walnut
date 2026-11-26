/**
 * The phone bar's page name (web/src/components/layout/page-name.ts) is read the way the router
 * matches a path: any case, a trailing slash, a plugin page's params.
 */
import { describe, expect, it } from 'vitest';
import { pageNameOf, NO_PAGE_NAME } from '../../web/src/components/layout/page-name';

describe('pageNameOf', () => {
  it('names an app by its title', () => {
    expect(pageNameOf('/notes', { title: 'Notes' })).toBe('Notes');
  });
  it('names a routed page that is not an app, as the router matches it', () => {
    expect(pageNameOf('/org', undefined)).toBe('Org');
    expect(pageNameOf('/AGENTS', undefined)).toBe('Agents');
    expect(pageNameOf('/memory/', undefined)).toBe('Memory');
    expect(pageNameOf('/%6Frg', undefined)).toBe('Org');
  });
  it('names a plugin page by its title, params included', () => {
    const pages = [{ path: '/garden/:bed', title: 'Garden' }];
    expect(pageNameOf('/garden/north', undefined, pages)).toBe('Garden');
    // The router's pick: a static path over a param one, whatever the order they came in.
    const both = [{ path: '/garden/:bed', title: 'Bed' }, { path: '/garden/overview', title: 'Overview' }];
    expect(pageNameOf('/garden/overview', undefined, both)).toBe('Overview');
  });
  it('falls back only where nothing has a name', () => {
    expect(pageNameOf('/open-ref', undefined)).toBe(NO_PAGE_NAME);
  });
});

describe('pageNameOf with a name the user set', () => {
  it('names the Org page as the user named the org', () => {
    expect(pageNameOf('/org', undefined, [], { '/org': 'Acme team' })).toBe('Acme team');
    expect(pageNameOf('/org', undefined, [], { '/org': '  ' })).toBe('Org');
  });
});

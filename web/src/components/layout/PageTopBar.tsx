/**
 * The shell's phone bar for the page on screen: PhoneTopBar with the page's name (page-name.ts),
 * read with what only a hook can see: the plugins' own pages, and the org's own name (the Org page is
 * named as the user named the org, the name its list title says on a wider screen).
 */
import { usePluginUi } from '@/plugins/hooks';
import { useOrgSettings } from '@/components/org/useOrgSettings';
import type { RegisteredApp } from '@/apps/registry';
import { pageNameOf } from './page-name';
import { PhoneTopBar, type PhoneTopBarProps } from './PhoneTopBar';

export function usePageName(pathname: string, app: Pick<RegisteredApp, 'title'> | undefined): string {
  const pluginPages = usePluginUi().pages;
  const org = useOrgSettings();
  return pageNameOf(pathname, app, pluginPages.map((p) => p.value), { '/org': org.settings.name });
}

interface PageTopBarProps extends Omit<PhoneTopBarProps, 'pageTitle'> {
  pathname: string;
  app: Pick<RegisteredApp, 'title'> | undefined;
}

export function PageTopBar({ pathname, app, ...rest }: PageTopBarProps) {
  return <PhoneTopBar pageTitle={usePageName(pathname, app)} {...rest} />;
}

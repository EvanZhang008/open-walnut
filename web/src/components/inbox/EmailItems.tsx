import type { InboxLetterItem } from '@/api/human-inbox-items';
import { useAppCatalog } from '@/apps/hooks';
import { EmailItem } from './EmailItem';
import { ambiguousAccounts } from './item-receipt-model';
import '@/styles/human-inbox-items.css';

export function EmailItems({ letterId, items, onNavigate }: {
  letterId: string; items?: InboxLetterItem[]; onNavigate: (to: string) => void;
}) {
  const catalog = useAppCatalog();
  if (!items?.length) return null;
  const canOpenMail = catalog.findByPath('/mail')?.key === 'core:mail';
  const duplicates = ambiguousAccounts(items);
  return <section className="hii-items" aria-label="Email items">
    <h2>Email items ({items.length})</h2>
    <p className="hii-snapshot">Mailbox counts in this summary are a snapshot, not live status.</p>
    {items.map(item => <EmailItem key={item.id} letterId={letterId} item={item} duplicateLabels={duplicates} canOpenMail={canOpenMail} onNavigate={onNavigate} />)}
  </section>;
}

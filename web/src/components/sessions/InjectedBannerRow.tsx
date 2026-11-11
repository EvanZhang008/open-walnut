import { StepIcon } from './StepIcon';
import { useRowDisclosure } from './row-disclosure';
import { AgentText } from '@/components/common/AgentText';
import type { InjectedBanner } from '@open-walnut/history-injected-banner';
import '@/styles/injected-banner.css';

/**
 * One folded `[Banner]…[/Banner]` block that Walnut prepended to a user turn.
 *
 * Same muted disclosure row as `InjectedContextRow`/`ToolRunShell` (`tool-run-*`)
 * on purpose: the panel already has ONE visual language for "machine text inside a
 * user turn", and a second style would just be a third convention to keep in sync.
 * Closed by default — the human's own words are the point of the bubble.
 *
 * Markdown renders lazily, only once opened: a catch-up block is a whole
 * conversation recap, and a session's history can hold many of them. No writer of its own.
 */
export function InjectedBannerRow({ banner, disclosureId }: {
  banner: InjectedBanner;
  /** Its message's id and place (the same banner rides many messages). */
  disclosureId?: string;
}) {
  const [open, setOpen] = useRowDisclosure(disclosureId, false);
  return (
    <div
      className="tool-run-row injected-banner-row"
      data-testid="injected-banner"
      data-banner-name={banner.name}
    >
      <button
        className="tool-run-toggle"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <span className="tool-run-label">{banner.label}</span>
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`}><StepIcon name="chevron" /></span>
      </button>
      {open && (
        <div className="tool-run-body" data-testid="injected-banner-body">
          <AgentText className="chat-tool-block-result" text={banner.body} unknownSource />
        </div>
      )}
    </div>
  );
}

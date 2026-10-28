/**
 * Top of Settings › Phones & Cloud: one line on how the phone reaches Walnut right
 * now, then the three ways to reach it away from home side by side. Each card's
 * button opens that way's own settings right under the cards (DevicesSection owns
 * which one is open). The words and states come from ways-model.ts.
 */
import type { NowLine, Way, WayId } from './ways-model';
import { SAME_WIFI_LINE } from './ways-model';
import { SettingsButton } from '../../inputs/SettingsButton';
import '@/styles/devices-ways.css';

interface Props {
  now: NowLine;
  ways: readonly Way[];
  openWay: WayId | null;
  onAction: (id: WayId) => void;
}

export function WaysOverview({ now, ways, openWay, onAction }: Props) {
  return (
    <div className="devices-ways" data-testid="devices-ways">
      <div className="devices-now" data-tone={now.tone} data-testid="devices-now">
        <div className="devices-now-title">{now.title}</div>
        {now.hops && (
          <div className="devices-now-hops" aria-label={now.hops.join(' to ')}>
            {now.hops.map((h, i) => (
              <span key={`${i}-${h}`} className="devices-now-hop-wrap">
                {i > 0 && <span className="devices-now-arrow" aria-hidden="true">→</span>}
                <span className="devices-now-hop">{h}</span>
              </span>
            ))}
          </div>
        )}
        {now.detail && <div className="devices-now-detail">{now.detail}</div>}
      </div>

      <div className="settings-group-heading devices-ways-heading">
        <h4 className="settings-group-title settings-subcard-title">Ways to reach Walnut away from home</h4>
      </div>
      <div className="devices-ways-grid">
        {ways.map((w) => {
          const open = openWay === w.id;
          return (
            <section
              key={w.id}
              className="devices-way"
              data-way={w.id}
              data-dot={w.dot}
              data-in-use={w.inUse ? 'true' : undefined}
              data-open={open ? 'true' : undefined}
              aria-label={w.title}
              data-testid={`devices-way-${w.id}`}
            >
              <div className="devices-way-head">
                <h5 className="devices-way-title">{w.title}</h5>
                {w.tag && <span className="devices-way-tag" data-dot={w.dot}>{w.tag}</span>}
              </div>
              <p className="devices-way-what">{w.what}</p>
              <dl className="devices-way-facts">
                <dt>Use it when</dt>
                <dd>{w.useWhen}</dd>
                <dt>Now</dt>
                <dd className="devices-way-status"><span className="devices-way-dot" data-dot={w.dot} aria-hidden="true" />{w.status}</dd>
              </dl>
              <div className="devices-way-foot">
                <SettingsButton
                  variant={w.action.primary && !open ? 'primary' : 'default'}
                  aria-expanded={open}
                  aria-controls={`devices-way-panel-${w.id}`}
                  data-testid={`devices-way-${w.id}-action`}
                  onClick={() => onAction(w.id)}
                >
                  {open ? 'Close' : w.action.label}
                </SettingsButton>
              </div>
            </section>
          );
        })}
      </div>
      <p className="devices-ways-home settings-row-help">{SAME_WIFI_LINE}</p>
    </div>
  );
}

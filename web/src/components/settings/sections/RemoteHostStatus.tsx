/**
 * Settings > Remote Hosts, the live part of a host's Details (HostDetails.tsx): why it is not
 * connected (HostFailureText, the SAME rendering the banner and the picker use: headline, the
 * server's hint verbatim, SSH output behind a toggle, a real countdown), the last reconnect
 * cause, and what Claude Code needs there. The row above already offers the fix (its one
 * action), says when the problem is hidden on the banner, and says the failure's headline as its
 * state line ("Connecting to Beta box timed out"), so none of them repeats here: the failure starts
 * with what the row does not say, the hint and the output (2026-11-05 review: a row's warning said
 * again in its Details).
 *
 * Its own component so a status push re-renders one host, not the section (the section owns
 * the auto-saving host editor the user may be typing in).
 */
import { useHostStatus } from '@/hooks/useHostStatus';
import { useHostActions } from '@/hooks/useHostActions';
import { hostProblemOf } from '@open-walnut/host-problem';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { RemoteHostReadiness } from './RemoteHostReadiness';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import '@/styles/host-picker-settings.css';

export function RemoteHostDetail({ alias, name }: { alias: string; name?: string }) {
  const status = useHostStatus(alias);
  const actions = useHostActions(alias);
  const replica = useIsReplicaServer();
  const label = status?.label || name || alias;
  const problem = hostProblemOf(status, { replica });

  const failure = problem?.type === 'connect'
    ? (
      <div className="rh-failure" data-host={alias} data-kind={problem.kind}>
        <HostFailureText
          headline="" hint={problem.hint} summary={problem.summary} kind={problem.kind}
          retryAt={problem.retryAt} lastFrameAt={status?.at}
        />
      </div>
    )
    : problem?.type === 'reconnecting' && problem.headline
      ? (
        <div className="rh-failure" data-host={alias} data-kind={problem.kind} data-type="reconnecting">
          <div className="hft-headline" title={problem.headline}>{`Last attempt: ${problem.headline}`}</div>
          {problem.hint && <div className="hft-hint"><InlineCodeText text={problem.hint} /></div>}
        </div>
      )
      : null;
  const readiness = problem?.type === 'off'
    ? null
    : <RemoteHostReadiness alias={alias} label={label} status={status} actions={actions} rowFixes={!replica} />;
  if (!failure && !status?.connected) return null;
  return (
    <div className="rh-host-detail" data-host={alias}>
      {failure}
      {readiness}
    </div>
  );
}

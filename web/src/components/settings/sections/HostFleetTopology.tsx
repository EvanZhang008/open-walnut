/**
 * The fleet as a diagram (Settings › Remote Hosts › Overview): this computer in
 * the centre, a line to every other host labelled with how Walnut reaches it,
 * each node coloured by its state. A host Walnut is not connected to is drawn
 * dashed and grey; the cloud companion carries a Cloud mark, and the host whose
 * Walnut server holds the phone tunnel carries a Phone mark. Layout and words
 * come from host-fleet-dashboard-model.ts.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import { clip, linkLabel, systemLine, topologyLayout, TOPO, type TopoNode } from './host-fleet-dashboard-model';
import { statusKind } from './host-fleet-model';

function Node({ node, host, onPick }: { node: TopoNode; host: FleetHost; onPick: (host: string) => void }) {
  const { nodeW: w, nodeH: h } = TOPO;
  const kind = node.live ? statusKind(host) : 'off';
  const phone = host.server?.phone === 'connected';
  const cloud = host.connection.kind === 'bridge';
  const mark = cloud ? 'Cloud' : phone ? 'Phone' : null;
  return (
    <g
      className="hf-topo-node" data-kind={kind} data-live={node.live ? 'true' : 'false'} data-testid="host-fleet-topo-node" data-host={host.host}
      transform={`translate(${node.x - w / 2} ${node.y - h / 2})`}
      role="button" tabIndex={0} aria-label={`${host.label}: ${node.live ? 'connected' : 'not connected'}`}
      onClick={() => onPick(host.host)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(host.host); } }}
    >
      <title>{`${host.label}\n${systemLine(host)}`}</title>
      <rect className="hf-topo-box" width={w} height={h} rx={10} />
      <circle className="hf-topo-dot" cx={14} cy={h / 2} r={4.5} />
      <text className="hf-topo-name" x={26} y={19}>{clip(host.label, mark ? 11 : 17)}</text>
      <text className="hf-topo-sub" x={26} y={34}>{clip(host.local ? 'Primary' : host.system?.os ?? (node.live ? 'Connected' : 'Offline'), 19)}</text>
      {mark && (
        <g className="hf-topo-mark" data-mark={mark.toLowerCase()} transform={`translate(${w - 50} 8)`}>
          <rect width={42} height={16} rx={8} />
          <text x={21} y={11.5} textAnchor="middle">{mark}</text>
        </g>
      )}
    </g>
  );
}

export function HostFleetTopology({ hosts, onPick }: { hosts: FleetHost[]; onPick: (host: string) => void }) {
  const { height, centre, nodes } = topologyLayout(hosts);
  const byHost = new Map(hosts.map((h) => [h.host, h]));
  const primary = centre ? byHost.get(centre.host) : undefined;
  const half = TOPO.nodeW / 2;
  return (
    <svg className="hf-topo" viewBox={`0 0 ${TOPO.width} ${height}`} width="100%" role="group" aria-label="How Walnut reaches each host" data-testid="host-fleet-topology">
      {/* Every line first, then every label, so no line crosses a label. */}
      {centre && nodes.map((n) => {
        const h = byHost.get(n.host)!;
        // From the primary's side edge to the node's inner edge, a gentle curve.
        const x1 = centre.x + (n.side === 'left' ? -half : half);
        const x2 = n.x + (n.side === 'left' ? half : -half);
        const mx = (x1 + x2) / 2;
        return (
          <path
            key={n.host} className="hf-topo-link" data-live={n.live ? 'true' : 'false'} data-kind={n.live ? statusKind(h) : 'off'}
            d={`M ${x1} ${centre.y} C ${mx} ${centre.y}, ${mx} ${n.y}, ${x2} ${n.y}`}
          />
        );
      })}
      {centre && nodes.map((n) => {
        const h = byHost.get(n.host)!;
        // Beside the node, on the side of the line away from the bend.
        const left = n.side === 'left';
        const x = n.x + (left ? half + 6 : -half - 6);
        const y = n.y > centre.y + 1 ? n.y + 14 : n.y - 6;
        return (
          <text
            key={n.host} className="hf-topo-label" data-live={n.live ? 'true' : 'false'} data-testid="host-fleet-topo-link" data-host={h.host}
            x={x} y={y} textAnchor={left ? 'start' : 'end'}
          >{linkLabel(h)}</text>
        );
      })}
      {centre && primary && <Node node={centre} host={primary} onPick={onPick} />}
      {nodes.map((n) => <Node key={n.host} node={n} host={byHost.get(n.host)!} onPick={onPick} />)}
    </svg>
  );
}

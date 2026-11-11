/**
 * The fleet as a diagram (Settings > Remote Hosts > Overview): this Mac in the centre, a line
 * to every other host labelled with how Walnut reaches it, each node coloured by its state. It
 * draws the list's own rows (host-list-store.ts), so it never disagrees with them (2026-11-04
 * review: the map drew 3 of 6 hosts, and drew a host green that its row said was off): every row
 * that is a machine, online or off as its row says, with the same latency. A host Walnut does not
 * reach is drawn dashed and grey; the cloud companion carries a Cloud mark, and the host whose
 * Walnut holds the phone tunnel a Phone mark. Layout comes from host-fleet-dashboard-model.ts.
 */
import { clip, topologyLayout, TOPO, type TopoNode } from './host-fleet-dashboard-model';
import { mapLinkLabel, type RowReport } from './host-row-model';

/** A node's colour, as its row's dot says it. */
export function topoKind(r: RowReport): 'connected' | 'warn' | 'failed' | 'off' {
  if (r.local) return r.needsLook ? 'warn' : 'connected';
  if (r.off) return 'off';
  if (!r.online) return 'failed';
  return r.needsLook ? 'warn' : 'connected';
}

function Node({ node, row, onPick }: { node: TopoNode; row: RowReport; onPick: (host: string) => void }) {
  const { nodeW: w, nodeH: h } = TOPO;
  const kind = topoKind(row);
  const mark = row.via === 'bridge' ? 'Cloud' : row.phone ? 'Phone' : null;
  const sub = row.local ? 'Runs Walnut' : row.off ? 'Off' : row.sub || (row.online ? (row.unstable ? 'Unstable' : 'Connected') : 'Not connected');
  return (
    <g
      className="hf-topo-node" data-kind={kind} data-live={node.live ? 'true' : 'false'} data-testid="host-fleet-topo-node" data-host={row.host}
      transform={`translate(${node.x - w / 2} ${node.y - h / 2})`}
      role="button" tabIndex={0} aria-label={`${row.name}: ${row.local ? 'this Mac' : row.off ? 'off' : row.online ? 'connected' : 'not connected'}`}
      onClick={() => onPick(row.host)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(row.host); } }}
    >
      <title>{`${row.name}\n${sub}`}</title>
      <rect className="hf-topo-box" width={w} height={h} rx={10} />
      <circle className="hf-topo-dot" cx={14} cy={h / 2} r={4.5} />
      <text className="hf-topo-name" x={26} y={19}>{clip(row.name, mark ? 11 : 17)}</text>
      <text className="hf-topo-sub" x={26} y={34}>{clip(sub, 19)}</text>
      {mark && (
        <g className="hf-topo-mark" data-mark={mark.toLowerCase()} transform={`translate(${w - 50} 8)`}>
          <rect width={42} height={16} rx={8} />
          <text x={21} y={11.5} textAnchor="middle">{mark}</text>
        </g>
      )}
    </g>
  );
}

export function HostFleetTopology({ rows, onPick }: { rows: RowReport[]; onPick: (host: string) => void }) {
  const shown = rows.filter((r) => r.counted);
  const { height, centre, nodes } = topologyLayout(shown.map((r) => ({ host: r.host, local: r.local, live: r.local || (!r.off && r.online) })));
  const byHost = new Map(shown.map((r) => [r.host, r]));
  const primary = centre ? byHost.get(centre.host) : undefined;
  const half = TOPO.nodeW / 2;
  return (
    <svg className="hf-topo" viewBox={`0 0 ${TOPO.width} ${height}`} width="100%" role="group" aria-label="How Walnut reaches each host" data-testid="host-fleet-topology">
      {/* Every line first, then every label, so no line crosses a label. */}
      {centre && nodes.map((n) => {
        const r = byHost.get(n.host)!;
        // From the primary's side edge to the node's inner edge, a gentle curve.
        const x1 = centre.x + (n.side === 'left' ? -half : half);
        const x2 = n.x + (n.side === 'left' ? half : -half);
        const mx = (x1 + x2) / 2;
        return (
          <path
            key={n.host} className="hf-topo-link" data-live={n.live ? 'true' : 'false'} data-kind={topoKind(r)}
            d={`M ${x1} ${centre.y} C ${mx} ${centre.y}, ${mx} ${n.y}, ${x2} ${n.y}`}
          />
        );
      })}
      {centre && nodes.map((n) => {
        const r = byHost.get(n.host)!;
        // Beside the node, on the side of the line away from the bend.
        const left = n.side === 'left';
        const x = n.x + (left ? half + 6 : -half - 6);
        const y = n.y > centre.y + 1 ? n.y + 14 : n.y - 6;
        return (
          <text
            key={n.host} className="hf-topo-label" data-live={n.live ? 'true' : 'false'} data-testid="host-fleet-topo-link" data-host={r.host}
            x={x} y={y} textAnchor={left ? 'start' : 'end'}
          >{mapLinkLabel(r)}</text>
        );
      })}
      {centre && primary && <Node node={centre} row={primary} onPick={onPick} />}
      {nodes.map((n) => <Node key={n.host} node={n} row={byHost.get(n.host)!} onPick={onPick} />)}
    </svg>
  );
}

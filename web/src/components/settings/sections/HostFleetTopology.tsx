/**
 * The fleet as a diagram (Settings > Remote Hosts > Overview): this Mac in the centre, a line
 * to every other host Walnut reaches labelled with how, each node coloured by its state. It
 * draws the list's own rows (host-list-store.ts), so it never disagrees with them (2026-11-04
 * review: the map drew 3 of 6 hosts, and drew a host green that its row said was off): every row
 * that is a machine, online or off as its row says, with the same latency. A host Walnut does not
 * reach is drawn dashed, its state said once, in its node: a dot in the summary's "need a look" tone
 * and its words (its line faint and wordless); the cloud companion carries a Cloud mark, and the host whose
 * Walnut holds the phone tunnel a Phone mark. Layout comes from host-fleet-dashboard-model.ts.
 */
import { clip, NAME_CHARS, nameLines, nodeHeight, topologyLayout, TOPO, type TopoNode } from './host-fleet-dashboard-model';
import { mapLinkLabel, type RowReport } from './host-row-model';

/** A node's colour, as its row's dot says it. */
export function topoKind(r: RowReport): 'connected' | 'warn' | 'failed' | 'off' {
  if (r.local) return r.needsLook ? 'warn' : 'connected';
  if (r.off) return 'off';
  if (!r.online) return 'failed';
  return r.needsLook ? 'warn' : 'connected';
}

/** The Cloud or Phone mark a node carries, if any. */
const markOf = (row: RowReport): 'Cloud' | 'Phone' | null => (row.via === 'bridge' ? 'Cloud' : row.phone ? 'Phone' : null);
const linesOf = (row: RowReport) => nameLines(row.name, markOf(row) ? NAME_CHARS.marked : NAME_CHARS.plain);

/** A node's sub line: a host Walnut does not reach always says so, in its line's words (Off, Not
 *  connected, Not connected in); a live one shows its system. A system it hides there stays in its
 *  hover and in its Details, which a click or Enter on the node opens. */
export function nodeSub(row: RowReport): string {
  if (row.local) return 'Runs Walnut';
  if (row.off) return 'Off';
  if (!row.online) return mapLinkLabel(row);
  return row.sub || (row.unstable ? 'Unstable' : 'Connected');
}

function Node({ node, row, h, onPick }: { node: TopoNode; row: RowReport; h: number; onPick: (host: string) => void }) {
  const w = TOPO.nodeW;
  const kind = topoKind(row);
  const mark = markOf(row);
  const name = linesOf(row);
  // The name and its sub line sit centred in the node (every node is as tall as the tallest one).
  const top = (h - nodeHeight(name.length)) / 2;
  const sub = nodeSub(row);
  return (
    <g
      className="hf-topo-node" data-kind={kind} data-live={node.live ? 'true' : 'false'} data-testid="host-fleet-topo-node" data-host={row.host}
      transform={`translate(${node.x - w / 2} ${node.y - h / 2})`}
      role="button" tabIndex={0} aria-label={`${row.name}: ${row.local ? 'runs Walnut' : row.online && !row.off ? 'connected' : sub.toLowerCase()}`}
      onClick={() => onPick(row.host)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(row.host); } }}
    >
      <title>{`${row.name}\n${sub}${!row.online && !row.off && row.sub ? `\n${row.sub}` : ''}`}</title>
      <rect className="hf-topo-box" width={w} height={h} rx={10} />
      <circle className="hf-topo-dot" cx={14} cy={h / 2} r={4.5} />
      <text className="hf-topo-name" x={26} y={top + 19}>
        {name.map((line, i) => <tspan key={i} x={26} dy={i ? TOPO.nameLine : 0}>{line}</tspan>)}
      </text>
      <text className="hf-topo-sub" x={26} y={top + 34 + (name.length - 1) * TOPO.nameLine}>{clip(sub, 19)}</text>
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
  const nodeH = Math.max(TOPO.nodeH, ...shown.map((r) => nodeHeight(linesOf(r).length)));
  const { height, centre, nodes } = topologyLayout(shown.map((r) => ({ host: r.host, local: r.local, live: r.local || (!r.off && r.online) })), nodeH);
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
        // A state is said once, in its node (2026-11-22 UI audit: "Not connected" on the line and in
        // the node): only a line Walnut uses carries words, how it reaches the host.
        if (!n.live) return null;
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
      {centre && primary && <Node node={centre} row={primary} h={nodeH} onPick={onPick} />}
      {nodes.map((n) => <Node key={n.host} node={n} row={byHost.get(n.host)!} h={nodeH} onPick={onPick} />)}
    </svg>
  );
}

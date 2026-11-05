/**
 * The mark where the chat leaves a stretch of turns out after a far jump
 * (render-skips.ts): the turns are loaded, just not drawn, until asked for.
 * Same line as a history gap (HistoryGapDivider), so the two read as one idea.
 */
export function RenderSkipDivider({ turns, rows, onShow }: { turns: number; rows: number; onShow: () => void }) {
  const what = turns > 0 ? `${turns} ${turns === 1 ? 'turn' : 'turns'}` : `${rows} messages`;
  return (
    <div className="session-gap-divider" data-testid="session-render-skip">
      <span className="session-gap-divider-label">{what} not shown here</span>
      <button type="button" className="session-gap-divider-btn" onClick={onShow}>Show them</button>
    </div>
  );
}

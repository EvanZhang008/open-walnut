/**
 * What a rule preview says after "Matches N mails" about the mail the rule would move (`moves` of
 * `matches`, from the server's preview): nothing when every matched mail would move, else how many
 * would and how many are already where the rule puts them. Shared by the Settings rule editor and the
 * mail correction card, so both say it the same way (2026-11-05: "moves 0" read as a number with no
 * meaning when all of the matched mail was already in that group).
 */
export function movesPhrase(matches: number, moves: number): string | null {
  if (moves >= matches) return null;
  if (moves <= 0) return matches === 1 ? 'already there' : 'all already there';
  return `${moves.toLocaleString('en-US')} would move, ${(matches - moves).toLocaleString('en-US')} already there`;
}

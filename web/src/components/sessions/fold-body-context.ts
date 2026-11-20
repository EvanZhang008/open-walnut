/**
 * Whether a row renders inside an opened fold's body (TurnFolds.tsx ProcessFoldRow).
 * There a run of tool calls draws its calls as rows of the fold's one flat list,
 * not a second "Ran 3 tools ›" line to open (2026-11-11, design 1: an opened turn
 * is one list, every step one row).
 */
import { createContext, useContext } from 'react';

export const InFoldBody = createContext(false);

export const useInFoldBody = () => useContext(InFoldBody);

/** Whether the run a call row sits in still runs: a call left with no result when its turn
 *  ended (cut, interrupted) stops breathing with the run (ToolRunShell `flat`). */
export const RunLive = createContext(true);
export const useRunLive = () => useContext(RunLive);

/** Whether a row renders inside a list of steps the reader opened (an opened fold's body,
 *  an opened run's body). There a thought is its step row (the icon, the word, its first
 *  line); on its own in the timeline it is the line every fold is, "> Thinking", with that
 *  row inside (SessionThinking; 2026-11-20, the user: "even if only one thining shoud also
 *  collapes", then "collpe like > Thinking ... just liek all other"). Off by default, so a
 *  new place that draws a thought starts as the fold line. */
export const InStepList = createContext(false);
export const useInStepList = () => useContext(InStepList);

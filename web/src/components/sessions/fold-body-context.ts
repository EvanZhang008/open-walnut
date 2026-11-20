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
 *  an opened run's body). Only there a "Thinking" row says the thought's first line; on
 *  its own in the timeline it is the one quiet word, however many thoughts it holds
 *  (2026-11-20, the user, of one live thought drawn with its first line between two of
 *  his messages: "even if only one thining shoud also collapes"). Off by default, so a
 *  new place that draws the row starts quiet. */
export const InStepList = createContext(false);
export const useInStepList = () => useContext(InStepList);

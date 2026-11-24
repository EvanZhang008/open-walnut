/**
 * The cloud companion and the phone follow a leader switch, case 2, "B gives up, A takes back" (the
 * product's path at these times): no commit by the deadline, A's job rolls back, A holds the dev box
 * again. Every process real; the world, the scaled time and every check are in
 * tests/helpers/leader-switch-companion-follow.ts.
 */
import { giveUpCase } from '../helpers/leader-switch-companion-follow.js'

giveUpCase()

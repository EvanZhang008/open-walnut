/**
 * The cloud companion and the phone follow a leader switch, case 1, "a commit lands late anyway":
 * B's late commit stands, the backup steps back, B holds the dev box. Every process real; the world,
 * the scaled time and every check are in tests/helpers/leader-switch-companion-follow.ts.
 */
import { lateCommitCase } from '../helpers/leader-switch-companion-follow.js'

lateCommitCase()

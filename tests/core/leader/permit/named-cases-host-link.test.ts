/**
 * Every named case of named-cases.test.ts again, with each witness reached by its machine's door over the caller's
 * host link (`host-link`, src/core/leader/switch/leader-relay.ts): the real caller and door of way b, on the
 * simulated network and clocks. The negative controls there must still go red over this way.
 */
import { simDefaults } from './sim.js'

simDefaults.way = 'host-link'
await import('./named-cases.test.js')

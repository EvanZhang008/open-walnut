/**
 * Places ops: read the visits the iPhone records once the user turns Places on
 * (src/core/places/).
 *
 * Read-only and primary-only, and only for a caller on this Mac, exactly like the
 * health ops: `localHostGateway` lets a session running here read them, and the
 * executor refuses every other origin (see src/lib/caller-origin.ts).
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { PLACES_LOCAL_ONLY_MESSAGE } from '../lib/caller-origin.js'

const PLACES_TAGS = { readonly: true, remote: 'deny', localHostGateway: true, primaryOnly: true } as const

const PRIVACY =
  'Where the user goes is personal. Walnut serves it only to sessions on this Mac and never syncs or relays it; if a '
  + 'read is refused, say so, and do not look for another way to it. What you write about it (a reply, a letter) is '
  + 'ordinary Walnut content that syncs like any other, so summarize, never paste coordinates or a list of addresses, '
  + 'and never write places into MEMORY.md, USER.md, notes or tasks unless the user asks.'

const COVERAGE =
  'Places records only after the user turned it on in Walnut on the iPhone, and only from then on: nothing from before '
  + 'that exists. iOS records a visit when the user stays somewhere for a while (minutes, not a drive past), so a short '
  + 'stop may be missing and there is no route between visits. Times are local, with the offset of where the visit was.'

defineOp({
  name: 'places_status',
  title: 'Places (iPhone visits) status',
  description:
    'Is Places on: `recording` is true when the iPhone has Places on AND location access set to Always (iOS records '
    + 'nothing otherwise). Also the phone\'s reported state, how many visits this Mac holds, the first and last, and when '
    + 'the phone last checked in. `message`, when present, is what to tell the user: pass it on in your own words. '
    + `Call this first when a places read comes back empty. ${COVERAGE} ${PRIVACY}`,
  input: {},
  bind: { method: 'GET', path: '/api/places/status' },
  localOnlyMessage: PLACES_LOCAL_ONLY_MESSAGE,
  tags: PLACES_TAGS,
})

defineOp({
  name: 'places_visits',
  title: 'Places the user visited',
  description:
    'The visits in a window, oldest first: arrival, departure, durationMin, the place name and address the phone looked '
    + 'up (null when it could not), and lat/lon (rounded, about 10 m). status `ongoing`: the user is still there '
    + '(durationMin counts to now); `departure_unknown`: iOS never reported the departure (or Places stopped recording '
    + 'first), so the length is unknown, never guess it; `arrivalUnknown`: iOS saw only the departure. `places` groups '
    + 'the same visits by place (name, or within 150 m) with visit count and total minutes, longest first. Default: the '
    + 'last 7 days. `place` keeps visits whose name or address contains the text. At most 90 days per call. '
    + `${COVERAGE} ${PRIVACY}`,
  input: {
    last_days: z.number().int().min(1).max(90).optional().describe('How many days ending now (default 7, max 90)'),
    from: z.string().max(40).optional().describe('YYYY-MM-DD or ISO-8601 instant (instead of last_days)'),
    to: z.string().max(40).optional().describe('YYYY-MM-DD (inclusive) or ISO-8601 instant (default now)'),
    place: z.string().max(100).optional().describe('Only visits whose place name or address contains this text'),
    limit: z.number().int().min(1).max(1000).optional().describe('Most visits to return, the latest kept (default 300)'),
  },
  bind: { method: 'GET', path: '/api/places/visits' },
  localOnlyMessage: PLACES_LOCAL_ONLY_MESSAGE,
  tags: PLACES_TAGS,
})

defineOp({
  name: 'places_label_set',
  title: 'Name a place (home, office, gym)',
  description:
    'Give a place the user\'s own name, once: every visit within radius_m (default 150 m) of it then reads with that '
    + 'label in places_visits and time_timeline ("office 9:20-18:05" instead of an address). Point it at a visit '
    + '(`visit_id` from places_visits) or at text in a visit\'s place name or address (`place`). `kind` is home, office, '
    + 'gym, school, shop, food, outdoors or other (a label named like a kind gets that kind). `remove:true` deletes the '
    + 'label. Only for a name the user gave or confirmed: ask "is the place at 1 Main St your office?" rather than guessing. '
    + 'Labels stay on this Mac; places_status lists them. ' + PRIVACY,
  input: {
    label: z.string().min(1).max(40).describe('The user\'s name for the place, e.g. home, office, gym, Mom\'s'),
    kind: z.enum(['home', 'office', 'gym', 'school', 'shop', 'food', 'outdoors', 'other']).optional().describe('What kind of place'),
    visit_id: z.string().max(100).optional().describe('A visit id from places_visits whose point the label takes'),
    place: z.string().max(100).optional().describe('Or: text in a visit\'s place name or address (the latest match is used)'),
    radius_m: z.number().min(20).max(2000).optional().describe('How far from the point still counts as this place (default 150)'),
    remove: z.boolean().optional().describe('true: delete this label'),
  },
  bind: { method: 'POST', path: '/api/places/labels' },
  localOnlyMessage: PLACES_LOCAL_ONLY_MESSAGE,
  tags: { readonly: false, remote: 'deny', localHostGateway: true, primaryOnly: true },
})

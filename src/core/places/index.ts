/**
 * Places on the primary box: the visits the iPhone records once the user turns
 * Places on (iOS visit monitoring, from then on only), and the agent reads.
 *
 * The iPhone keeps this Mac current (POST /api/v1/places/sync); a cloud replica
 * only relays. Nothing here ever runs on a replica.
 */

import { closePlacesDb } from './db.js'

export { placesStoreExists } from './db.js'
export { ingestPlacesSync, deletePlacesData, PLACES_MAX_VISITS_PER_SYNC, PLACES_MAX_SYNC_BYTES } from './ingest.js'
export { placesStatus, placesVisits, PlacesQueryError, PLACES_NOT_ON } from './queries.js'
export { labelAt, listPlaceLabels, setPlaceLabel, PLACE_KINDS, type PlaceKind, type PlaceLabel } from './labels.js'
export { runPlacesAction, isPlacesAction, emptyPlacesStatus, type PlacesAction } from './relay.js'

/** Server stop: no open handle survives (the next start in a test opens a fresh one). */
export function stopPlaces(): void {
  closePlacesDb()
}

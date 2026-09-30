/**
 * Display-only unit conversion. Stored values are ALWAYS the canonical unit
 * (catalog.ts); a read adds a human string in the phone's preferred unit next
 * to the canonical number, and never replaces it.
 */

import type { PreferredUnits } from './sanitize.js'

const one = (v: number): string => (Math.round(v * 10) / 10).toString()

export function displayTemperature(celsius: number | null, pref: PreferredUnits): string | null {
  if (celsius === null) return null
  return pref.temperature === 'degF' ? `${one(celsius * 9 / 5 + 32)} °F` : `${one(celsius)} °C`
}

export function displayDistance(meters: number | null, pref: PreferredUnits): string | null {
  if (meters === null) return null
  return pref.distance === 'mi' ? `${one(meters / 1609.344)} mi` : `${one(meters / 1000)} km`
}

export function displayEnergy(kcal: number | null, pref: PreferredUnits): string | null {
  if (kcal === null) return null
  return pref.energy === 'kJ' ? `${Math.round(kcal * 4.184)} kJ` : `${Math.round(kcal)} kcal`
}

/**
 * JSON keys that name a secret. An answer that holds one is never kept for a replay: not by
 * the applied-ops ledger (a device pairing answers its live bearer token once,
 * offline-merge/ledger.ts), nor by the op-call registry (src/ops/op-calls.ts), whose answers
 * also cover a vault item's fields.
 */
export const SECRET_KEYS = /"(token|accessToken|refreshToken|bearer|secret|clientSecret|password|passphrase|apiKey|api_key|pairingURI|pairingUri|privateKey|private_key|credentials?)"\s*:/i

/** The same, plus the fields a vault item answers with (ops/vault.ts password_use). */
export const ANSWER_SECRET_KEYS = /"(token|accessToken|refreshToken|bearer|secret|clientSecret|password|passphrase|apiKey|api_key|pairingURI|pairingUri|privateKey|private_key|credentials?|totp|card_number|card_code|card_expiry|waitToken)"\s*:/i

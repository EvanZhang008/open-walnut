#!/bin/bash
# notarize <file>: submit to Apple's notary service and wait; print its log and
# fail when it is not accepted. Sourced by build-release.sh; reads
# WALNUT_NOTARY_KEY, WALNUT_NOTARY_KEY_ID and WALNUT_NOTARY_ISSUER.
#
# Only Apple's answer ends the wait. A request that fails on the way (2026-10-23:
# "NSURLErrorDomain -1001 The request timed out" while polling a submission that
# had been uploaded) says nothing about the submission, so the same one is waited
# on again until the 45-minute budget runs out. It is never submitted twice.
NOTARIZE_BUDGET_SECS=${NOTARIZE_BUDGET_SECS:-2700}
NOTARIZE_RETRY_SECS=${NOTARIZE_RETRY_SECS:-30}

# The submission id, from the JSON answer or from the URL in a transport error.
notary_submission_id() {
    printf '%s' "$1" | sed -n \
        -e 's/.*"id":"\([0-9a-fA-F-]\{36\}\)".*/\1/p' \
        -e 's/.*submissions\/\([0-9a-fA-F-]\{36\}\).*/\1/p' | head -n 1
}

notarize() {
    local file="$1" out id deadline now left
    deadline=$(( $(date +%s) + NOTARIZE_BUDGET_SECS ))
    out=$(xcrun notarytool submit "$file" --key "$WALNUT_NOTARY_KEY" --key-id "$WALNUT_NOTARY_KEY_ID" \
        --issuer "$WALNUT_NOTARY_ISSUER" --wait --timeout "${NOTARIZE_BUDGET_SECS}s" --output-format json 2>&1) || true
    echo "$out"
    id=$(notary_submission_id "$out")
    # Without a final status or a timeout Apple did not answer; ask again about the same submission.
    while [ -n "$id" ]; do
        case "$out" in *'"status":"Accepted"'*|*'"status":"Invalid"'*|*'"status":"Rejected"'*|*'Timeout of'*) break ;; esac
        now=$(date +%s)
        left=$(( deadline - now - NOTARIZE_RETRY_SECS ))
        if [ "$left" -le 0 ]; then
            out="Timeout of ${NOTARIZE_BUDGET_SECS}s reached with no answer from Apple"
            break
        fi
        echo "No answer from Apple about submission $id; waiting on it again in ${NOTARIZE_RETRY_SECS}s (${left}s left)." >&2
        sleep "$NOTARIZE_RETRY_SECS"
        out=$(xcrun notarytool wait "$id" --key "$WALNUT_NOTARY_KEY" --key-id "$WALNUT_NOTARY_KEY_ID" \
            --issuer "$WALNUT_NOTARY_ISSUER" --timeout "${left}s" --output-format json 2>&1) || true
        echo "$out"
    done
    case "$out" in
        *'"status":"Accepted"'*) ;;
        *'Timeout of'*)
            # Apple is still working on it, which is not a rejection: a team's
            # first submissions can take hours (2026-10-11: over an hour), later
            # ones minutes. Run the job again once `notarytool info <id>` says Accepted.
            echo "::error::Apple had not finished notarizing $(basename "$file") after $(( NOTARIZE_BUDGET_SECS / 60 )) minutes (submission $id, not rejected). Run this job again once \`xcrun notarytool info $id\` says Accepted." >&2
            return 1 ;;
        *)
            if [ -n "$id" ]; then
                xcrun notarytool log "$id" --key "$WALNUT_NOTARY_KEY" \
                    --key-id "$WALNUT_NOTARY_KEY_ID" --issuer "$WALNUT_NOTARY_ISSUER" || true
            fi
            echo "Notarization of $(basename "$file") was not accepted." >&2
            return 1 ;;
    esac
}

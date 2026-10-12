#!/usr/bin/env bash
# End-to-end check of the clip caption edit gate against a running server.
#
# Make executable once: chmod +x scripts/verify-captions.sh
#
# JOB_ID must be in AWAITING_MANIFEST_APPROVAL and CLIP_ID a non-assembled
# clip in its manifest whose generated slice exists and has at least two
# blocks. The clip must start with no saved edit (step 1 asserts
# edited == null); the script deletes its own edit at step 8, but a run that
# fails between steps 6 and 8 leaves VERIFY-CAPTIONS saved — clear it with
# DELETE before re-running.
#
# Required env: API_URL ADMIN_TOKEN JOB_ID CLIP_ID
# Optional env: DONE_JOB_ID  a COMPLETED job; step 11 is skipped when unset.
#               DONE_CLIP_ID a clip in DONE_JOB_ID's manifest (defaults to
#                            CLIP_ID). It must exist there, or the clip check
#                            404s before the status gate can 409.
#               VERBOSE=1 prints every response body.
#
# Status codes: GET and PUT return 200; DELETE returns 204 (@HttpCode).
set -euo pipefail

for var in API_URL ADMIN_TOKEN JOB_ID CLIP_ID; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required env var: $var" >&2
    exit 2
  fi
done
for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 2; }
done

BASE="$API_URL/admin/pipeline/jobs"
CAPS="$BASE/$JOB_ID/clips/$CLIP_ID/captions"
ADMIN=(-H "Authorization: Bearer $ADMIN_TOKEN")
JSON=(-H "Content-Type: application/json")
BODY=/tmp/body

# expect <code> <label> <curl args...>
expect() {
  local want="$1" label="$2"
  shift 2
  local got
  got=$(curl -s -o "$BODY" -w '%{http_code}' "$@") || true
  if [[ "$got" == "$want" ]]; then
    echo "PASS [$got] $label"
    if [[ "${VERBOSE:-0}" == "1" ]]; then
      cat "$BODY"
      echo
    fi
  else
    echo "FAIL [got $got, expected $want] $label"
    cat "$BODY"
    echo
    exit 1
  fi
}

# check <label> <jq args...>  — jq -e against the last response body.
check() {
  local label="$1"
  shift
  if jq -e "$@" "$BODY" >/dev/null; then
    echo "      ok: $label"
  else
    echo "FAIL assert: $label"
    cat "$BODY"
    echo
    exit 1
  fi
}

echo "== Read =="
# 1
expect 200 "1. GET captions" "$CAPS" "${ADMIN[@]}"
check "generated is a non-empty array" \
  '(.generated | type) == "array" and (.generated | length) > 0'
check "generated has at least 2 blocks (steps 4 and 7 use block 2)" \
  '(.generated | length) >= 2'
check "edited is null" '.edited == null'
# 2
GEN=$(jq -c '.generated' "$BODY")
EDIT_OK=$(jq -c '{blocks: (map({index, text}) | .[0].text = "VERIFY-CAPTIONS")}' \
  <<<"$GEN")
echo "      built EDIT_OK from $(jq 'length' <<<"$GEN") generated block(s)"

echo "== Rejected edits =="
# 3
expect 422 "3. PUT wrong count" -X PUT "$CAPS" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$(jq -c '{blocks: .blocks[0:1]}' <<<"$EDIT_OK")"
check "message contains \"expected\"" '.message | contains("expected")'
# 4
expect 422 "4. PUT block 2 index 999" -X PUT "$CAPS" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$(jq -c '.blocks[1].index = 999' <<<"$EDIT_OK")"
check "message contains \"position 2\"" '.message | contains("position 2")'
check "position == 2" '.position == 2'
# 5
expect 422 "5. PUT every text empty" -X PUT "$CAPS" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$(jq -c '.blocks |= map(.text = "")' <<<"$EDIT_OK")"
check "message contains \"no text\"" '.message | contains("no text")'

echo "== Save =="
# 6
expect 200 "6. PUT EDIT_OK" -X PUT "$CAPS" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$EDIT_OK"
check "blocks[0].text is VERIFY-CAPTIONS" \
  '.blocks[0].text == "VERIFY-CAPTIONS"'
check "blocks[0].startMs is the generated startMs" --argjson gen "$GEN" \
  '.blocks[0].startMs == $gen[0].startMs'
# 7
expect 200 "7. GET captions after save" "$CAPS" "${ADMIN[@]}"
check "edited[0].text is VERIFY-CAPTIONS" \
  '.edited[0].text == "VERIFY-CAPTIONS"'
check "edited[1] equals generated[1]" '.edited[1] == .generated[1]'

echo "== Revert =="
# 8
expect 204 "8. DELETE captions" -X DELETE "$CAPS" "${ADMIN[@]}"
expect 200 "8. GET captions after delete" "$CAPS" "${ADMIN[@]}"
check "edited is null" '.edited == null'
# 9
expect 204 "9. DELETE captions again (idempotent)" -X DELETE "$CAPS" \
  "${ADMIN[@]}"

echo "== Clip id guards =="
# 10
expect 400 "10. GET with clipId bad%2Fid" \
  "$BASE/$JOB_ID/clips/bad%2Fid/captions" "${ADMIN[@]}"
expect 404 "10. GET with clipId clip_does_not_exist" \
  "$BASE/$JOB_ID/clips/clip_does_not_exist/captions" "${ADMIN[@]}"

echo "== Status gate =="
# 11
if [[ -n "${DONE_JOB_ID:-}" ]]; then
  DONE_CAPS="$BASE/$DONE_JOB_ID/clips/${DONE_CLIP_ID:-$CLIP_ID}/captions"
  expect 409 "11. PUT EDIT_OK against COMPLETED job" -X PUT "$DONE_CAPS" \
    "${ADMIN[@]}" "${JSON[@]}" -d "$EDIT_OK"
  check "message names the status" '.message | contains("COMPLETED")'
else
  echo "SKIP 11. DONE_JOB_ID not set"
fi

echo
echo "All caption checks passed (job $JOB_ID, clip $CLIP_ID)."

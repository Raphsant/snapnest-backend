#!/usr/bin/env bash
# End-to-end check of the client intake flow against a running server.
#
# Re-seeding is enough to re-run with the same client; a fresh client is not
# required. Each seed creates a new program version (so a new session) and
# bumps the agency's ndaVersion, which resets the NDA gate.
#
# Required env: API_URL CLIENT_TOKEN STAFF_TOKEN AGENCY_ID
#               STEP1_ID STEP2_ID Q1_ID Q2_ID Q3_ID Q4_ID Q5_ID TEST_VIDEO
# Optional env: VERBOSE=1 prints every response body.
#
# Status codes: progress, submit and staff status POSTs return 200
# (@HttpCode). nda/accept and the /uploads POSTs return Nest's default 201.
set -euo pipefail

for var in API_URL CLIENT_TOKEN STAFF_TOKEN AGENCY_ID STEP1_ID STEP2_ID \
  Q1_ID Q2_ID Q3_ID Q4_ID Q5_ID TEST_VIDEO; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required env var: $var" >&2
    exit 2
  fi
done
for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 2; }
done
[[ -f "$TEST_VIDEO" ]] || { echo "TEST_VIDEO not found: $TEST_VIDEO" >&2; exit 2; }

BASE="$API_URL/agency/$AGENCY_ID"
CLIENT=(-H "Authorization: Bearer $CLIENT_TOKEN")
STAFF=(-H "Authorization: Bearer $STAFF_TOKEN")
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

# Uploads TEST_VIDEO through the real flow into the answers folder.
# Sets LAST_FILE_ID.
LAST_FILE_ID=""
upload_video() {
  local name size upload_id upload_url
  name="intake-$(date +%s)-$RANDOM.mp4"
  size=$(wc -c <"$TEST_VIDEO" | tr -d ' ')

  expect 201 "POST /uploads ($name)" -X POST "$API_URL/uploads" \
    "${CLIENT[@]}" "${JSON[@]}" \
    -d "$(jq -n --arg n "$name" --argjson s "$size" \
      --arg f "$ANSWERS_FOLDER_ID" --arg a "$AGENCY_ID" \
      '{fileName: $n, mimeType: "video/mp4", sizeBytes: $s,
        folderId: $f, agencyId: $a, source: "camera"}')"
  upload_id=$(jq -r '.uploadId' "$BODY")
  upload_url=$(jq -r '.uploadUrl' "$BODY")
  LAST_FILE_ID=$(jq -r '.fileId' "$BODY")

  # Presigned PUT is bound to Content-Type = mimeType.
  expect 200 "PUT S3 object ($name)" -X PUT -H "Content-Type: video/mp4" \
    --upload-file "$TEST_VIDEO" "$upload_url"

  expect 201 "POST /uploads/$upload_id/complete" \
    -X POST "$API_URL/uploads/$upload_id/complete" \
    "${CLIENT[@]}" "${JSON[@]}" -d '{}'
  check "file is UPLOADED" '.uploadStatus == "UPLOADED"'
}

echo "== NDA gate =="
# 1
expect 403 "1. GET intake before NDA" "$BASE/intake" "${CLIENT[@]}"
# 2
expect 200 "2. GET nda" "$BASE/nda" "${CLIENT[@]}"
check "required is true" '.required == true'
NDA_VERSION=$(jq -r '.version' "$BODY")
# 3
expect 409 "3. POST nda/accept with wrong version" -X POST "$BASE/nda/accept" \
  "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"fullName": "Intake Verify", "version": "wrong"}'
# 4
expect 201 "4. POST nda/accept with version $NDA_VERSION" \
  -X POST "$BASE/nda/accept" "${CLIENT[@]}" "${JSON[@]}" \
  -d "$(jq -n --arg v "$NDA_VERSION" '{fullName: "Intake Verify", version: $v}')"
check "required is now false" '.required == false and .accepted.version != null'

echo "== Step gating =="
# 5
expect 200 "5. GET intake" "$BASE/intake" "${CLIENT[@]}"
check "unlockedStepIds == [STEP1]" --arg s1 "$STEP1_ID" \
  '.session.unlockedStepIds == [$s1]'
ANSWERS_FOLDER_ID=$(jq -r '.session.answersFolderId' "$BODY")
SESSION_ID=$(jq -r '.session.id' "$BODY")
echo "      session=$SESSION_ID answersFolder=$ANSWERS_FOLDER_ID"
# 6
expect 403 "6. progress on locked STEP2" -X POST \
  "$BASE/intake/steps/$STEP2_ID/progress" "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"watchedSeconds": 30}'
# 7
expect 403 "7. answer Q1 before STEP1 is watched" -X PUT \
  "$BASE/intake/answers/$Q1_ID" "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"fileId": "00000000-0000-4000-8000-000000000000"}'

echo "== Watch progress =="
# 8
expect 200 "8. STEP1 progress 10s" -X POST \
  "$BASE/intake/steps/$STEP1_ID/progress" "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"watchedSeconds": 10}'
check "STEP1 not yet watched" --arg s "$STEP1_ID" \
  '.stepProgress[$s].watchedSeconds == 10 and .stepProgress[$s].watchedAt == null'
# 9
expect 200 "9. STEP1 progress 5s (must not decrease)" -X POST \
  "$BASE/intake/steps/$STEP1_ID/progress" "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"watchedSeconds": 5}'
check "watchedSeconds still 10" --arg s "$STEP1_ID" \
  '.stepProgress[$s].watchedSeconds == 10'
# 10
expect 200 "10. STEP1 progress 29s" -X POST \
  "$BASE/intake/steps/$STEP1_ID/progress" "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"watchedSeconds": 29}'
check "STEP1 watchedAt set" --arg s "$STEP1_ID" \
  '.stepProgress[$s].watchedAt != null'

echo "== Answers =="
# 11
upload_video
FILE1_ID="$LAST_FILE_ID"
upload_video
FILE2_ID="$LAST_FILE_ID"
echo "      file1=$FILE1_ID file2=$FILE2_ID"
# 12
expect 200 "12. answer Q1 with file1" -X PUT "$BASE/intake/answers/$Q1_ID" \
  "${CLIENT[@]}" "${JSON[@]}" -d "{\"fileId\": \"$FILE1_ID\"}"
# 13
expect 409 "13. answer Q2 with file1 (reuse)" -X PUT \
  "$BASE/intake/answers/$Q2_ID" "${CLIENT[@]}" "${JSON[@]}" \
  -d "{\"fileId\": \"$FILE1_ID\"}"
# 14
expect 200 "14. answer Q2 with file2" -X PUT "$BASE/intake/answers/$Q2_ID" \
  "${CLIENT[@]}" "${JSON[@]}" -d "{\"fileId\": \"$FILE2_ID\"}"
# 15
expect 200 "15. GET intake" "$BASE/intake" "${CLIENT[@]}"
check "unlockedStepIds == [STEP1, STEP2]" \
  --arg s1 "$STEP1_ID" --arg s2 "$STEP2_ID" \
  '.session.unlockedStepIds == [$s1, $s2]'
cp "$BODY" /tmp/intake.json

echo "== Incomplete submit and delete guard =="
# 16
expect 409 "16. submit incomplete" -X POST "$BASE/intake/submit" "${CLIENT[@]}"
check "message names STEP2 and Q3" --arg s2 "$STEP2_ID" --arg q3 "$Q3_ID" \
  '(.message | tostring) as $m | ($m | contains($s2)) and ($m | contains($q3))'
# 17
expect 409 "17. DELETE answers folder" -X DELETE \
  "$API_URL/folders/$ANSWERS_FOLDER_ID" "${CLIENT[@]}"
check "blocked by intake session" '(.message | tostring) | contains("intake session")'

echo "== Remaining steps =="
# 18: driven by the program layout from step 15, in step order, so each step
# is unlocked by the time it is watched.
ANSWERED_LATE=""
jq -r --arg s1 "$STEP1_ID" \
  '.program.steps[] | select(.id != $s1) | "\(.id) \(.explainerDurationSec)"' \
  /tmp/intake.json >/tmp/intake-steps.txt
while read -r step_id duration <&3; do
  expect 200 "18. watch step $step_id (${duration}s)" -X POST \
    "$BASE/intake/steps/$step_id/progress" "${CLIENT[@]}" "${JSON[@]}" \
    -d "{\"watchedSeconds\": $duration}"
  check "step $step_id watchedAt set" --arg s "$step_id" \
    '.stepProgress[$s].watchedAt != null'
  for q in $(jq -r --arg s "$step_id" \
    '.program.steps[] | select(.id == $s) | .questions[].id' /tmp/intake.json); do
    upload_video
    expect 200 "18. answer $q" -X PUT "$BASE/intake/answers/$q" \
      "${CLIENT[@]}" "${JSON[@]}" -d "{\"fileId\": \"$LAST_FILE_ID\"}"
    ANSWERED_LATE="$ANSWERED_LATE $q"
  done
done 3</tmp/intake-steps.txt
got_late=$(echo "$ANSWERED_LATE" | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')
want_late=$(printf '%s\n' "$Q3_ID" "$Q4_ID" "$Q5_ID" | sort | tr '\n' ' ')
if [[ "$got_late" != "$want_late" ]]; then
  echo "FAIL assert: step 18 answered [$got_late], expected [$want_late]"
  exit 1
fi
echo "      ok: answered exactly Q3, Q4, Q5"

echo "== Submit =="
# 19
expect 200 "19. submit" -X POST "$BASE/intake/submit" "${CLIENT[@]}"
check "status SUBMITTED" '.status == "SUBMITTED" and .submittedAt != null'
# 20
expect 409 "20. progress after submit" -X POST \
  "$BASE/intake/steps/$STEP1_ID/progress" "${CLIENT[@]}" "${JSON[@]}" \
  -d '{"watchedSeconds": 30}'

echo "== Staff =="
# 21
expect 403 "21. list sessions as client" "$BASE/intake/sessions" "${CLIENT[@]}"
# 22
expect 200 "22. list sessions as staff" "$BASE/intake/sessions" "${STAFF[@]}"
# Sessions from earlier program versions stay listed, so match by id.
check "this session listed with answeredCount 5" --arg id "$SESSION_ID" \
  'any(.[]; .id == $id and .answeredCount == 5)'
# 23
expect 200 "23. get session as staff" "$BASE/intake/sessions/$SESSION_ID" \
  "${STAFF[@]}"
check "5 answers, all with viewUrl" \
  '(.answers | length) == 5 and ([.answers[].viewUrl] | all(. != null))'
# 24
expect 409 "24. SUBMITTED -> COMPLETE (skips PROCESSING)" -X POST \
  "$BASE/intake/sessions/$SESSION_ID/status" "${STAFF[@]}" "${JSON[@]}" \
  -d '{"status": "COMPLETE"}'
# 25
expect 200 "25. SUBMITTED -> PROCESSING" -X POST \
  "$BASE/intake/sessions/$SESSION_ID/status" "${STAFF[@]}" "${JSON[@]}" \
  -d '{"status": "PROCESSING"}'
check "status PROCESSING" '.status == "PROCESSING"'
# 26
expect 200 "26. PROCESSING -> COMPLETE" -X POST \
  "$BASE/intake/sessions/$SESSION_ID/status" "${STAFF[@]}" "${JSON[@]}" \
  -d '{"status": "COMPLETE"}'
check "status COMPLETE" '.status == "COMPLETE"'

echo
echo "All intake checks passed (session $SESSION_ID)."

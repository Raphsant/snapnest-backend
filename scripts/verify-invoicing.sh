#!/usr/bin/env bash
# End-to-end check of the admin invoicing API against a running server.
#
# Make executable once: chmod +x scripts/verify-invoicing.sh
#
# WARNING: every run issues REAL, permanent invoices (there is no delete) and
# consumes numbers from the series of VERIFY_INVOICE_DATE's year — about nine
# invoices and one credit note per run, with PDFs uploaded to S3. Point it at
# a test client and a sandbox year so the real STC series stays gap-free:
#   VERIFY_CLIENT_CODE=VTEST VERIFY_INVOICE_DATE=2099-01-15
# The client must already exist (create it once with POST /clients).
#
# Required env: API_URL ADMIN_TOKEN
# Optional env: VERIFY_CLIENT_CODE   client to bill (default ALPHA)
#               VERIFY_INVOICE_DATE  YYYY-MM-DD for every issued document
#                                    (default today, UTC)
#               VERBOSE=1 prints every response body.
#
# Prerequisites: issuer profile v1 is current; client ALPHA exists (steps 1-3
# read it even when VERIFY_CLIENT_CODE is something else).
#
# Status codes: POST /clients and POST /invoices return Nest's default 201;
# pay, void and render-pdf return 200 (@HttpCode).
set -euo pipefail

for var in API_URL ADMIN_TOKEN; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required env var: $var" >&2
    exit 2
  fi
done
for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 2; }
done

BASE="$API_URL/admin/invoicing"
INV="$BASE/invoices"
ADMIN=(-H "Authorization: Bearer $ADMIN_TOKEN")
JSON=(-H "Content-Type: application/json")
BODY=/tmp/body
HEADERS=/tmp/invoicing-headers

TODAY=$(jq -rn 'now | strftime("%Y-%m-%d")')
CLIENT_CODE="${VERIFY_CLIENT_CODE:-ALPHA}"
INVOICE_DATE="${VERIFY_INVOICE_DATE:-$TODAY}"
YEAR="${INVOICE_DATE:0:4}"
DUE_NET30=$(jq -rn --arg d "$INVOICE_DATE" \
  '$d + "T00:00:00Z" | fromdateiso8601 + 30 * 86400 | strftime("%Y-%m-%d")')

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

# issue_body <kind> <clientId> <items-json> [extra jq filter]
issue_body() {
  jq -nc --arg kind "$1" --arg c "$2" --arg d "$INVOICE_DATE" \
    --argjson items "$3" \
    "{kind: \$kind, clientId: \$c, invoiceDate: \$d, terms: \"Due upon receipt\",
      taxRateBps: 0, language: \"EN\", items: \$items} | ${4:-.}"
}

ITEMS_A='[{"name":"Evento Houston","description":"Turnkey Event Production — end-to-end planning","qty":1,"unitPriceCents":600000}]'
echo "Client $CLIENT_CODE, invoiceDate $INVOICE_DATE (series $YEAR)"

echo "== Issuer and clients =="
# 1
expect 200 "1. GET issuer" "$BASE/issuer" "${ADMIN[@]}"
check 'legalName is "Samywamy LLC"' '.legalName == "Samywamy LLC"'
# 2
expect 200 "2. GET clients" "$BASE/clients" "${ADMIN[@]}"
check "contains code ALPHA" 'any(.[]; .code == "ALPHA")'
CLIENT_ID=$(jq -r --arg code "$CLIENT_CODE" \
  '.[] | select(.code == $code) | .id' "$BODY")
[[ -n "$CLIENT_ID" ]] || { echo "FAIL client $CLIENT_CODE not found"; exit 1; }
echo "      CLIENT_ID=$CLIENT_ID ($CLIENT_CODE)"
# 3
expect 409 "3. POST duplicate code ALPHA" -X POST "$BASE/clients" \
  "${ADMIN[@]}" "${JSON[@]}" -d '{"code":"ALPHA","name":"dup"}'
# 4
expect 400 "4. POST lowercase code vt" -X POST "$BASE/clients" \
  "${ADMIN[@]}" "${JSON[@]}" -d '{"code":"vt","name":"x"}'

echo "== Issue =="
# 5
expect 200 "5. GET next-number INVOICE $YEAR" \
  "$BASE/next-number?kind=INVOICE&year=$YEAR" "${ADMIN[@]}"
check "invoiceNo matches ^STC-$YEAR-NNN\$" --arg y "$YEAR" \
  '.invoiceNo | test("^STC-" + $y + "-[0-9]{3}$")'
EXPECTED_NEXT=$(jq -r '.invoiceNo' "$BODY")
# 6
BODY_A=$(issue_body INVOICE "$CLIENT_ID" "$ITEMS_A")
expect 201 "6. POST invoice A" -X POST "$INV" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$BODY_A"
check "invoiceNo == $EXPECTED_NEXT" --arg n "$EXPECTED_NEXT" '.invoiceNo == $n'
check "totalCents 600000" '.totalCents == 600000'
check "status ISSUED" '.status == "ISSUED"'
check "pdfError null" '.pdfError == null'
check "pdfS3Key non-null" '.pdfS3Key != null'
check "billToName snapshotted" --arg c "$CLIENT_CODE" \
  'if $c == "ALPHA" then .billToName == "Alpha Alliance" else .billToName != null end'
INV_A=$(jq -r '.id' "$BODY")
INV_A_NO=$(jq -r '.invoiceNo' "$BODY")
INV_A_FILE=$(jq -r '.pdfFilename' "$BODY")
# 7
echo "      ValidationPipe has whitelist + forbidNonWhitelisted (nested too): expect 400"
expect 400 "7. POST with injected subtotalCents and items[0].amountCents" \
  -X POST "$INV" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$(jq -c '.subtotalCents = 1 | .items[0].amountCents = 1' <<<"$BODY_A")"
check "message says the totals fields should not exist" \
  '.message | tostring | contains("should not exist")'
# 8
expect 201 "8. POST invoice B (ES, Net 30, 8.25%)" -X POST "$INV" \
  "${ADMIN[@]}" "${JSON[@]}" \
  -d "$(issue_body INVOICE "$CLIENT_ID" \
    '[{"name":"Clip edits","description":"Edición — corte vertical","qty":2,"unitPriceCents":150000},
      {"name":"Event coverage","description":"Producción — cobertura","qty":1,"unitPriceCents":900000}]' \
    '.taxRateBps = 825 | .terms = "Net 30" | .language = "ES"')"
check "subtotalCents 1200000" '.subtotalCents == 1200000'
check "taxCents 99000" '.taxCents == 99000'
check "totalCents 1299000" '.totalCents == 1299000'
check "dueDate is $DUE_NET30" --arg due "$DUE_NET30" '.dueDate | startswith($due)'
INV_B=$(jq -r '.id' "$BODY")
INV_B_NO=$(jq -r '.invoiceNo' "$BODY")

echo "== Download =="
# 9
expect 200 "9. GET download-url A" "$INV/$INV_A/download-url" "${ADMIN[@]}"
check "url present" '.url | type == "string" and length > 0'
URL=$(jq -r '.url' "$BODY")
# Presigned for GET, so fetch with GET and keep only the headers (HEAD 403s).
got=$(curl -s -o /dev/null -D "$HEADERS" -w '%{http_code}' "$URL") || true
if [[ "$got" == "200" ]] \
  && grep -qi '^content-type: application/pdf' "$HEADERS" \
  && grep -i '^content-disposition:' "$HEADERS" | grep -qF "$INV_A_FILE"; then
  echo "PASS [$got] 9. GET presigned url: application/pdf, attachment $INV_A_FILE"
else
  echo "FAIL [got $got] 9. GET presigned url"
  cat "$HEADERS"
  exit 1
fi

echo "== Parallel numbering =="
# 10
for i in 1 2 3 4 5; do
  curl -s -o "/tmp/invoicing-par-$i.json" -w '%{http_code}' -X POST "$INV" \
    "${ADMIN[@]}" "${JSON[@]}" -d "$BODY_A" >"/tmp/invoicing-par-$i.code" &
done
wait
PAR_NOS=()
for i in 1 2 3 4 5; do
  code=$(cat "/tmp/invoicing-par-$i.code")
  if [[ "$code" != "201" ]]; then
    echo "FAIL [got $code, expected 201] 10. parallel POST #$i"
    cat "/tmp/invoicing-par-$i.json"
    echo
    exit 1
  fi
  PAR_NOS+=("$(jq -r '.invoiceNo' "/tmp/invoicing-par-$i.json")")
done
SEQS=$(for i in 1 2 3 4 5; do jq -r '.seq' "/tmp/invoicing-par-$i.json"; done \
  | sort -n)
DISTINCT=$(uniq <<<"$SEQS" | wc -l | tr -d ' ')
SPAN=$(( $(tail -1 <<<"$SEQS") - $(head -1 <<<"$SEQS") ))
if [[ "$DISTINCT" == "5" && "$SPAN" == "4" ]]; then
  echo "PASS [201 x5] 10. parallel issue: distinct and consecutive (seq $(tr '\n' ' ' <<<"$SEQS"))"
else
  echo "FAIL 10. parallel seqs not distinct/consecutive: $(tr '\n' ' ' <<<"$SEQS")"
  exit 1
fi

echo "== Status transitions =="
# 11
expect 200 "11. POST pay A" -X POST "$INV/$INV_A/pay" "${ADMIN[@]}" \
  "${JSON[@]}" -d "{\"paidDate\":\"$TODAY\"}"
check "status PAID" '.status == "PAID"'
expect 409 "11. POST pay A again" -X POST "$INV/$INV_A/pay" "${ADMIN[@]}" \
  "${JSON[@]}" -d "{\"paidDate\":\"$TODAY\"}"
# 12
expect 409 "12. POST void A (PAID)" -X POST "$INV/$INV_A/void" "${ADMIN[@]}" \
  "${JSON[@]}" -d '{"reason":"x"}'
# 13
expect 200 "13. POST void B" -X POST "$INV/$INV_B/void" "${ADMIN[@]}" \
  "${JSON[@]}" -d '{"reason":"test void"}'
check "status VOID" '.status == "VOID"'
check 'voidReason "test void"' '.voidReason == "test void"'

echo "== Correction =="
# 14
expect 200 "14. GET correction draft for B" "$INV/$INV_B/correction" \
  "${ADMIN[@]}"
check "replacesInvoiceId == B" --arg b "$INV_B" '.replacesInvoiceId == $b'
check "items length 2" '.items | length == 2'
# The draft dates itself today; keep the correction in the sandbox series.
DRAFT=$(jq -c --arg d "$INVOICE_DATE" '.invoiceDate = $d' "$BODY")
expect 201 "14. POST correction" -X POST "$INV" "${ADMIN[@]}" "${JSON[@]}" \
  -d "$DRAFT"
check "replaces.invoiceNo == $INV_B_NO" --arg n "$INV_B_NO" \
  '.replaces.invoiceNo == $n'
echo "      (service does not prepend \"Replaces\" to notes; the relation is the link)"
INV_C=$(jq -r '.id' "$BODY")
INV_C_NO=$(jq -r '.invoiceNo' "$BODY")

echo "== Credit notes =="
ITEMS_CN='[{"name":"Evento Houston","description":"Turnkey Event Production — partial credit","qty":1,"unitPriceCents":100000}]'
# 15
expect 201 "15. POST credit note for A" -X POST "$INV" "${ADMIN[@]}" \
  "${JSON[@]}" \
  -d "$(issue_body CREDIT_NOTE "$CLIENT_ID" "$ITEMS_CN" \
    ".replacesInvoiceId = \"$INV_A\"")"
check "invoiceNo matches ^STC-CN-$YEAR-NNN\$" --arg y "$YEAR" \
  '.invoiceNo | test("^STC-CN-" + $y + "-[0-9]{3}$")'
check "kind CREDIT_NOTE" '.kind == "CREDIT_NOTE"'
CN=$(jq -r '.id' "$BODY")
CN_NO=$(jq -r '.invoiceNo' "$BODY")
# 16
expect 409 "16. POST pay credit note" -X POST "$INV/$CN/pay" "${ADMIN[@]}" \
  "${JSON[@]}" -d "{\"paidDate\":\"$TODAY\"}"
check '"Credit notes are not paid"' '.message == "Credit notes are not paid"'
# 17
expect 409 "17. POST credit note for B (VOID)" -X POST "$INV" "${ADMIN[@]}" \
  "${JSON[@]}" \
  -d "$(issue_body CREDIT_NOTE "$CLIENT_ID" "$ITEMS_CN" \
    ".replacesInvoiceId = \"$INV_B\"")"

echo "== Listing =="
# 18
expect 200 "18. GET invoices?status=ISSUED" "$INV?status=ISSUED" "${ADMIN[@]}"
check "openTotalCents == sum of ISSUED INVOICE totals" \
  '([.invoices[] | select(.kind == "INVOICE") | .totalCents] | add // 0)
     == .openTotalCents'
check "credit note listed with daysOutstanding null" --arg cn "$CN" \
  'any(.invoices[]; .id == $cn and .daysOutstanding == null)'

echo "== Id guards =="
# 19
expect 404 "19. GET unknown uuid" \
  "$INV/00000000-0000-4000-8000-000000000000" "${ADMIN[@]}"
expect 400 "19. GET not-a-uuid" "$INV/not-a-uuid" "${ADMIN[@]}"

echo "== PDF re-render =="
# 20
expect 200 "20. POST render-pdf C" -X POST "$INV/$INV_C/render-pdf" \
  "${ADMIN[@]}"
check "pdfError null" '.pdfError == null'

echo
echo "All invoicing checks passed. Issued in series $YEAR: $INV_A_NO $INV_B_NO" \
  "${PAR_NOS[*]} $INV_C_NO $CN_NO"

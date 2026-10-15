-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "billToName" TEXT,
ADD COLUMN "billToLines" TEXT[];

-- Backfill invoices issued before the snapshot existed from their client's
-- current row, using the same line order and empty-skipping as issue().
UPDATE "Invoice" AS i
SET "billToName" = c."name",
    "billToLines" = ARRAY(
      SELECT t.line
      FROM unnest(ARRAY[c."contactName", c."addressLine1", c."addressLine2",
                        c."email", c."phone"]) WITH ORDINALITY AS t(line, ord)
      WHERE t.line IS NOT NULL AND btrim(t.line) <> ''
      ORDER BY t.ord
    )
FROM "InvoiceClient" AS c
WHERE c."id" = i."clientId";

ALTER TABLE "Invoice" ALTER COLUMN "billToName" SET NOT NULL;

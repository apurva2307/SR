-- An authority no longer records an office order number. It is identified by
-- its holder, its issuer and its period; the audit chain already names who
-- issued it and when.
ALTER TABLE approval_authorities DROP COLUMN order_reference;

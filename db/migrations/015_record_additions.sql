-- Pages added to a service record after it was indexed: an increment order, a
-- transfer order, a fresh certificate. The original PDF in the source folder is
-- never touched; each addition is its own PDF in a separate, application-owned
-- folder, shown after the original as one continuous record.

CREATE TABLE record_additions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_record_id uuid NOT NULL REFERENCES service_records(id),
  -- Order of addition. Withdrawn additions keep their number, so a page cited
  -- as "addition 3" always means the same paper.
  seq               integer NOT NULL CHECK (seq > 0),
  description       text NOT NULL CHECK (length(btrim(description)) >= 5),
  -- The date on the paper itself, when the custodian knows it.
  document_date     date,
  original_name     text NOT NULL,
  source_kind       text NOT NULL CHECK (source_kind IN ('PDF','IMAGE')),

  file_path         text NOT NULL,          -- realpath-guarded on use, like the originals
  sha256            text NOT NULL,          -- of the stored PDF, for the integrity check
  -- Of the bytes as uploaded. An image is converted to PDF on the way in, and
  -- the conversion need not be byte-identical twice, so duplicates are judged
  -- on what the custodian actually chose.
  source_sha256     text NOT NULL,
  byte_size         bigint NOT NULL,
  page_count        integer NOT NULL CHECK (page_count > 0),

  uploaded_by       uuid NOT NULL REFERENCES users(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  last_verified_at  timestamptz,

  -- Never deleted. A mistaken upload is withdrawn, with a reason, and stays
  -- in the history.
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','WITHDRAWN')),
  withdrawn_by      uuid REFERENCES users(id),
  withdrawn_at      timestamptz,
  withdrawal_reason text,

  UNIQUE (service_record_id, seq),
  CONSTRAINT addition_withdrawal_complete CHECK (
    (status = 'ACTIVE' AND withdrawn_at IS NULL)
    OR (status = 'WITHDRAWN' AND withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL
        AND length(btrim(coalesce(withdrawal_reason, ''))) > 0))
);

CREATE INDEX record_additions_record_idx ON record_additions (service_record_id, seq);
-- The same paper attached twice is almost always a slip; refuse it.
CREATE UNIQUE INDEX record_additions_live_sha ON record_additions (source_sha256) WHERE status = 'ACTIVE';

-- An upload the custodian has not yet confirmed. Shown back to them, page by
-- page, before it joins the record; abandoned ones are swept after a day.
CREATE TABLE addition_uploads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_record_id uuid NOT NULL REFERENCES service_records(id),
  uploaded_by       uuid NOT NULL REFERENCES users(id),
  original_name     text NOT NULL,
  source_kind       text NOT NULL CHECK (source_kind IN ('PDF','IMAGE')),
  file_path         text NOT NULL,
  sha256            text NOT NULL,
  source_sha256     text NOT NULL,
  byte_size         bigint NOT NULL,
  page_count        integer NOT NULL CHECK (page_count > 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Pages from live additions, kept on the record so every list that shows a
-- page count shows the whole record without a join.
ALTER TABLE service_records ADD COLUMN added_page_count integer NOT NULL DEFAULT 0;

ALTER TABLE access_events DROP CONSTRAINT event_type_known;
ALTER TABLE access_events ADD CONSTRAINT event_type_known CHECK (event_type IN (
  'LOGIN_OK','LOGIN_FAIL','LOCKOUT','LOGOUT','SESSION_REVOKED','PASSWORD_CHANGED',
  'SEARCH','RECORD_METADATA_VIEWED',
  'REQUEST_SUBMITTED','REQUEST_WITHDRAWN','ITEM_APPROVED','ITEM_REJECTED',
  'GRANT_CREATED','GRANT_REVOKED','GRANT_EXPIRED','EMERGENCY_GRANT_ISSUED',
  'AUTHORITY_ISSUED','AUTHORITY_SUSPENDED','AUTHORITY_RESUMED','AUTHORITY_REVOKED',
  'AUTHORITY_EXTENDED','AUTHORITY_EXPIRED','DECISION_REFUSED_NO_AUTHORITY',
  'VIEW_SESSION_OPENED','PAGE_SERVED','PAGE_DENIED','VIEW_SESSION_CLOSED','THUMBNAIL_SERVED',
  'INGEST_RUN','RECORD_INDEXED','RECORD_SUPERSEDED','QUARANTINE_RESOLVED',
  'RECORD_PAGES_ADDED','RECORD_PAGES_WITHDRAWN','RECORD_ADDITIONS_CARRIED',
  'METADATA_CORRECTED','INTEGRITY_ALERT',
  'USER_CREATED','USER_SUSPENDED','USER_REACTIVATED','USER_PROFILE_UPDATED',
  'ROLE_GRANTED','ROLE_REVOKED','SETTING_CHANGED',
  'DEPARTMENT_CREATED','DEPARTMENT_UPDATED','DEPARTMENT_DEACTIVATED',
  'DEPARTMENT_ACTIVATED','DEPARTMENT_DELETED',
  'TOTP_REQUIRED','TOTP_REQUIREMENT_LIFTED','TOTP_ENROLLED','TOTP_DISABLED','TOTP_RESET',
  'PASSWORD_RESET_ISSUED','PASSWORD_RESET_REDEEMED','PASSWORD_RESET_FAILED'
));

-- §5.3 Requests and permission. State lives at three levels because one
-- pension case touches several records and an approver may release only some
-- of them (§3.1).

CREATE TABLE access_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no        text NOT NULL UNIQUE,
  requester_id      uuid NOT NULL REFERENCES users(id),
  requester_dept_id uuid NOT NULL REFERENCES departments(id),
  -- An unexplained request is not defensible six years later (§5.3).
  purpose           text CHECK (purpose IS NULL OR length(btrim(purpose)) >= 20),
  file_reference    text,
  requested_from    timestamptz,
  requested_to      timestamptz,
  status            text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','SUBMITTED','WITHDRAWN','DECIDED')),
  submitted_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Purpose and period are required at submit, not at create (§9).
  CONSTRAINT submitted_requests_are_complete CHECK (
    status = 'DRAFT' OR (
      purpose IS NOT NULL AND requested_from IS NOT NULL
      AND requested_to IS NOT NULL AND requested_to > requested_from
    )
  )
);
CREATE INDEX access_requests_requester_idx ON access_requests (requester_id, created_at DESC);
CREATE INDEX access_requests_open_idx ON access_requests (submitted_at) WHERE status = 'SUBMITTED';

CREATE TABLE access_request_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  service_record_id uuid NOT NULL REFERENCES service_records(id),
  item_status       text NOT NULL DEFAULT 'PENDING'
                      CHECK (item_status IN ('PENDING','APPROVED','REJECTED')),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_remarks  text,
  UNIQUE (request_id, service_record_id)
);
CREATE INDEX request_items_pending_idx ON access_request_items (request_id) WHERE item_status = 'PENDING';

-- The authoritative permission object. The ONLY thing the page endpoint
-- consults (§6.1).
CREATE TABLE access_grants (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: an emergency grant exists without a fabricated request behind it.
  request_item_id             uuid UNIQUE REFERENCES access_request_items(id),
  user_id                     uuid NOT NULL REFERENCES users(id),
  service_record_id           uuid NOT NULL REFERENCES service_records(id),

  valid_from                  timestamptz NOT NULL,
  valid_until                 timestamptz NOT NULL,
  max_views                   integer,
  view_count                  integer NOT NULL DEFAULT 0,

  granted_by                  uuid NOT NULL REFERENCES users(id),
  -- NOT NULL by design: every open door traces to the authorisation that
  -- opened it, and stays traceable after that authority is withdrawn (§6.2).
  granted_under_authority_id  uuid NOT NULL REFERENCES approval_authorities(id),

  origin                      text NOT NULL DEFAULT 'REQUEST'
                                CHECK (origin IN ('REQUEST','EMERGENCY')),
  revoked_at                  timestamptz,
  revoked_by                  uuid REFERENCES users(id),
  revoke_reason               text,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT grant_period_sane CHECK (valid_until > valid_from),
  -- The last layer still enforcing policy after the third UI rewrite (§5.3).
  -- Changing the cap is a migration, deliberately.
  CONSTRAINT grant_period_capped CHECK (valid_until - valid_from <= interval '180 days'),
  CONSTRAINT grant_views_sane CHECK (max_views IS NULL OR max_views > 0),
  CONSTRAINT emergency_grants_have_no_item CHECK (
    origin <> 'EMERGENCY' OR request_item_id IS NULL
  ),
  CONSTRAINT revocation_is_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);

-- The hot path: §6.1 runs against this on every single page fetch.
CREATE INDEX access_grants_live_idx
  ON access_grants (user_id, service_record_id, valid_until)
  WHERE revoked_at IS NULL;

-- The live access register, sorted by expiry (§10).
CREATE INDEX access_grants_expiry_idx
  ON access_grants (valid_until) WHERE revoked_at IS NULL;

-- "Which grants did this authority open?" — needed when one is withdrawn (§6.2).
CREATE INDEX access_grants_authority_idx ON access_grants (granted_under_authority_id);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz,
  emailed_at timestamptz
);
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

-- Auth extras and the view-session grouping the audit log needs (§12.1).

ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;

-- Reset is an offline procedure: a custodian verifies identity, an admin
-- issues a single-use code. No email-based self-service reset, because the
-- email account is not a stronger factor than the password it protects (§11).
CREATE TABLE password_reset_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  code_hash  text NOT NULL,
  issued_by  uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_open_idx ON password_reset_codes (user_id) WHERE used_at IS NULL;

-- One sitting with one record. PAGE_SERVED audit rows hang off this so an
-- 84-page read stays readable in the auditor's view.
CREATE TABLE view_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  service_record_id uuid NOT NULL REFERENCES service_records(id),
  grant_id          uuid REFERENCES access_grants(id),
  via               text NOT NULL CHECK (via IN ('GRANT','CUSTODIAL_ROLE')),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  last_page_at      timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  pages_served      integer NOT NULL DEFAULT 0,
  first_page        integer,
  last_page         integer,
  ip                inet,
  user_agent        text
);
CREATE INDEX view_sessions_open_idx ON view_sessions (user_id, service_record_id) WHERE closed_at IS NULL;

ALTER TABLE access_events
  ADD CONSTRAINT access_events_view_session_fk
  FOREIGN KEY (view_session_id) REFERENCES view_sessions(id);

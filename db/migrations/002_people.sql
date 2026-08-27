-- §5.1 People and structure.

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('ACCOUNTS','USER_DEPT')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_code            text NOT NULL UNIQUE,
  full_name             text NOT NULL,
  email                 text UNIQUE,
  department_id         uuid NOT NULL REFERENCES departments(id),
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  totp_secret           text,
  last_login_at         timestamptz,
  -- Never deleted: audit rows point here forever (§5.1).
  status                text NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_department_idx ON users (department_id) WHERE status = 'ACTIVE';

-- Seeded, not user-editable. A new role is a migration, deliberately (§5.1).
CREATE TABLE roles (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL
);

INSERT INTO roles (code, name, description) VALUES
  ('REQUESTER',          'Requester',          'Search the catalogue and raise access requests.'),
  ('APPROVER',           'Approver',           'Eligible to decide requests. Releases nothing without a live approval authority (§6.2).'),
  ('CUSTODIAN',          'Custodian',          'Run ingestion, resolve quarantine, correct metadata.'),
  ('CONTROLLING_OFFICER','Controlling officer','Issue, suspend and withdraw approval authorities.'),
  ('AUDITOR',            'Auditor',            'Read the audit log. Cannot open a record.'),
  ('ADMIN',              'Administrator',      'Manage users, departments and settings. Cannot open a record.');

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id),
  role_id    text NOT NULL REFERENCES roles(code),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  refresh_token_hash text NOT NULL UNIQUE,
  -- Reuse of a spent refresh token kills the whole family (§11).
  family_id          uuid NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  ip                 inet,
  user_agent         text,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

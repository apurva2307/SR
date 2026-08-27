-- §2.1 / §6.2 — the power to RELEASE a record to somebody else, held
-- separately from the power to READ one. The approver role marks eligibility;
-- a live row here is what actually permits a decision.

CREATE TABLE approval_authorities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  issued_by       uuid NOT NULL REFERENCES users(id),
  -- The written office order this authority rests on. Not optional: an
  -- authority with no order behind it is exactly what this table exists to
  -- prevent.
  order_reference text NOT NULL,
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz NOT NULL,
  -- NULL = may release to any user department. A list restricts which
  -- departments this officer may release TO. Scope is by requesting
  -- department, never by record — records carry no departmental label (§6.2).
  scope_dept_ids  uuid[],
  status          text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  suspended_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES users(id),
  remarks         text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT authority_period_sane CHECK (effective_to > effective_from),
  -- Issuing to oneself is refused in the API too; this makes it impossible.
  CONSTRAINT authority_not_self_issued CHECK (user_id <> issued_by)
);

CREATE INDEX authorities_live_idx
  ON approval_authorities (user_id, effective_to)
  WHERE status = 'ACTIVE';

CREATE INDEX authorities_expiry_idx
  ON approval_authorities (effective_to)
  WHERE status = 'ACTIVE';

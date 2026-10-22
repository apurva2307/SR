-- Correcting a record's employee name or PPO number after it was indexed.
--
-- The parsed values were the only source until now, and ingestion still never
-- invents one. A correction is a person's decision, with a reason, kept here
-- for good and mirrored in the audit log:
--   * a name is corrected by a custodian, and takes effect at once;
--   * a PPO number is a change of identity, so a custodian proposes it and a
--     controlling officer — never the same person — approves or rejects it.
-- The value it replaced stays findable through record_aliases.

COMMENT ON COLUMN service_records.employee_name IS
  'As parsed from the filename, unless corrected — see record_corrections.';
COMMENT ON COLUMN service_records.ppo_number IS
  'As parsed, punctuation intact, unless corrected — see record_corrections.';

CREATE TABLE record_corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_record_id uuid NOT NULL REFERENCES service_records(id),
  field             text NOT NULL CHECK (field IN ('EMPLOYEE_NAME','PPO_NUMBER')),
  old_value         text NOT NULL,
  new_value         text NOT NULL,
  reason            text NOT NULL CHECK (length(btrim(reason)) >= 10),
  status            text NOT NULL CHECK (status IN ('PENDING','APPLIED','REJECTED','WITHDRAWN')),

  proposed_by       uuid NOT NULL REFERENCES users(id),
  proposed_at       timestamptz NOT NULL DEFAULT now(),
  -- For a name, the custodian who made it; for a PPO, the officer who decided
  -- it, or the custodian who withdrew it.
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_remarks  text,

  CONSTRAINT correction_changes_something CHECK (new_value <> old_value),
  CONSTRAINT correction_decision_complete CHECK (
    (status = 'PENDING') = (decided_at IS NULL)
    AND (status = 'PENDING') = (decided_by IS NULL)),
  -- Only a PPO waits for anyone.
  CONSTRAINT correction_name_is_direct CHECK (field <> 'EMPLOYEE_NAME' OR status = 'APPLIED'),
  -- The officer who approves or rejects a PPO change is never the one who proposed it.
  CONSTRAINT correction_ppo_second_officer CHECK (
    field <> 'PPO_NUMBER' OR status NOT IN ('APPLIED','REJECTED') OR decided_by <> proposed_by),
  CONSTRAINT correction_withdrawn_by_proposer CHECK (status <> 'WITHDRAWN' OR decided_by = proposed_by),
  CONSTRAINT correction_rejection_explained CHECK (
    status <> 'REJECTED' OR length(btrim(coalesce(decision_remarks, ''))) > 0)
);

CREATE INDEX record_corrections_record_idx ON record_corrections (service_record_id, proposed_at DESC);
-- One open PPO proposal per record: two in flight would be decided against
-- a value that no longer holds.
CREATE UNIQUE INDEX record_corrections_one_pending
  ON record_corrections (service_record_id) WHERE status = 'PENDING';

-- The history is permanent. A pending proposal may be decided once; nothing
-- else changes and nothing is deleted.
CREATE FUNCTION record_corrections_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'record_corrections keeps every correction; nothing is deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'PENDING'
     OR NEW.id <> OLD.id OR NEW.service_record_id <> OLD.service_record_id
     OR NEW.field <> OLD.field OR NEW.old_value <> OLD.old_value OR NEW.new_value <> OLD.new_value
     OR NEW.reason <> OLD.reason OR NEW.proposed_by <> OLD.proposed_by
     OR NEW.proposed_at <> OLD.proposed_at THEN
    RAISE EXCEPTION 'a correction can only be decided, once, while it is pending'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER record_corrections_guard
  BEFORE UPDATE OR DELETE ON record_corrections
  FOR EACH ROW EXECUTE FUNCTION record_corrections_guard();

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
  'METADATA_CORRECTED','CORRECTION_PROPOSED','CORRECTION_REJECTED','CORRECTION_WITHDRAWN',
  'INTEGRITY_ALERT',
  'USER_CREATED','USER_SUSPENDED','USER_REACTIVATED','USER_PROFILE_UPDATED',
  'ROLE_GRANTED','ROLE_REVOKED','SETTING_CHANGED',
  'DEPARTMENT_CREATED','DEPARTMENT_UPDATED','DEPARTMENT_DEACTIVATED',
  'DEPARTMENT_ACTIVATED','DEPARTMENT_DELETED',
  'TOTP_REQUIRED','TOTP_REQUIREMENT_LIFTED','TOTP_ENROLLED','TOTP_DISABLED','TOTP_RESET',
  'PASSWORD_RESET_ISSUED','PASSWORD_RESET_REDEEMED','PASSWORD_RESET_FAILED'
));

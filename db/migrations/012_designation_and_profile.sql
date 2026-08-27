-- §5.1 A person's designation — Senior Accounts Officer, Head Clerk — which is
-- what a written office order names them as, and is not derivable from either
-- their department or their roles.
--
-- Nullable, and left NULL for everyone already on file. Backfilling it from
-- roles would put a job title nobody holds into the audit trail: ADMIN is a
-- permission, not a post.
ALTER TABLE users ADD COLUMN designation text;

-- A user editing their own name, email or designation. Distinct from
-- USER_CREATED because it is the account holder acting on themselves, and the
-- name on an audit row from last year should stay explainable when the name on
-- the account has since changed.
ALTER TABLE access_events DROP CONSTRAINT event_type_known;
ALTER TABLE access_events ADD CONSTRAINT event_type_known CHECK (event_type IN (
  'LOGIN_OK','LOGIN_FAIL','LOCKOUT','LOGOUT','SESSION_REVOKED','PASSWORD_CHANGED',
  'SEARCH','RECORD_METADATA_VIEWED',
  'REQUEST_SUBMITTED','REQUEST_WITHDRAWN','ITEM_APPROVED','ITEM_REJECTED',
  'GRANT_CREATED','GRANT_REVOKED','GRANT_EXPIRED','EMERGENCY_GRANT_ISSUED',
  'AUTHORITY_ISSUED','AUTHORITY_SUSPENDED','AUTHORITY_RESUMED','AUTHORITY_REVOKED',
  'AUTHORITY_EXPIRED','DECISION_REFUSED_NO_AUTHORITY',
  'VIEW_SESSION_OPENED','PAGE_SERVED','PAGE_DENIED','VIEW_SESSION_CLOSED','THUMBNAIL_SERVED',
  'INGEST_RUN','RECORD_INDEXED','RECORD_SUPERSEDED','QUARANTINE_RESOLVED',
  'METADATA_CORRECTED','INTEGRITY_ALERT',
  'USER_CREATED','USER_SUSPENDED','USER_REACTIVATED','USER_PROFILE_UPDATED',
  'ROLE_GRANTED','ROLE_REVOKED','SETTING_CHANGED',
  'DEPARTMENT_CREATED','DEPARTMENT_UPDATED','DEPARTMENT_DEACTIVATED',
  'DEPARTMENT_ACTIVATED','DEPARTMENT_DELETED',
  'TOTP_REQUIRED','TOTP_REQUIREMENT_LIFTED','TOTP_ENROLLED','TOTP_DISABLED','TOTP_RESET',
  'PASSWORD_RESET_ISSUED','PASSWORD_RESET_REDEEMED','PASSWORD_RESET_FAILED'
));

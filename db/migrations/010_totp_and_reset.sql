-- Two-factor enrolment and password-reset redemption.
--
-- Before this, an administrator "enabling" 2FA wrote a secret and flipped the
-- flag in one step, showing the secret to the ADMINISTRATOR. The user was then
-- required to produce codes from a secret they had never been given — an
-- immediate lockout. Enrolment has to be done by the person holding the phone.

-- The administrator REQUIRES 2FA; the user ENROLS. Separate facts.
ALTER TABLE users ADD COLUMN totp_required boolean NOT NULL DEFAULT false;

-- A secret that has been generated but not yet proven. It only becomes
-- totp_secret once the user has typed a code it produced, so a half-finished
-- enrolment can never lock anyone out.
ALTER TABLE users ADD COLUMN totp_pending_secret text;

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
  'USER_CREATED','USER_SUSPENDED','ROLE_GRANTED','ROLE_REVOKED','SETTING_CHANGED',
  'DEPARTMENT_CREATED','DEPARTMENT_UPDATED','DEPARTMENT_DEACTIVATED',
  'DEPARTMENT_ACTIVATED','DEPARTMENT_DELETED',
  'TOTP_REQUIRED','TOTP_REQUIREMENT_LIFTED','TOTP_ENROLLED','TOTP_DISABLED','TOTP_RESET',
  'PASSWORD_RESET_ISSUED','PASSWORD_RESET_REDEEMED','PASSWORD_RESET_FAILED'
));

-- Whoever holds an unused code can take over the account, so only one may be
-- outstanding per user at a time.
--
-- Existing rows are retired first, keeping the newest: before this rule there
-- was nothing stopping an administrator issuing five codes in a row, and a
-- migration that only applies to an empty table is a migration that fails on
-- the day it matters.
UPDATE password_reset_codes p
   SET used_at = now()
 WHERE used_at IS NULL
   AND EXISTS (
     SELECT 1 FROM password_reset_codes q
      WHERE q.user_id = p.user_id AND q.used_at IS NULL
        AND (q.created_at, q.id) > (p.created_at, p.id)
   );

CREATE UNIQUE INDEX password_reset_one_open
  ON password_reset_codes (user_id) WHERE used_at IS NULL;

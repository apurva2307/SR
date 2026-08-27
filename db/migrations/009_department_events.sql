-- Departments become manageable from Administration, so their lifecycle needs
-- audit event types. Adding one is a migration, deliberately: the CHECK on
-- access_events is what stops a typo becoming an unqueryable event name.

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
  'DEPARTMENT_ACTIVATED','DEPARTMENT_DELETED'
));

-- A department code is how people refer to it out loud; two departments sharing
-- one is a filing error waiting to happen. It was already UNIQUE; make the
-- comparison case-insensitive so "PW" and "pw" cannot both exist.
CREATE UNIQUE INDEX departments_code_ci ON departments (upper(code));

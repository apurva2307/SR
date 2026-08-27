-- §12 The log outlives the grants, the requests, and probably the
-- application. It is the one table with no update path and no delete path.

CREATE TABLE access_events (
  seq               bigserial PRIMARY KEY,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  actor_id          uuid REFERENCES users(id),      -- NULL for scheduled jobs
  actor_ip          inet,
  user_agent        text,
  event_type        text NOT NULL,
  outcome           text NOT NULL DEFAULT 'ALLOW' CHECK (outcome IN ('ALLOW','DENY')),

  service_record_id uuid REFERENCES service_records(id),
  request_id        uuid REFERENCES access_requests(id),
  grant_id          uuid REFERENCES access_grants(id),
  authority_id      uuid REFERENCES approval_authorities(id),
  -- Groups the PAGE_SERVED rows of one sitting so an 84-page read stays
  -- readable in the auditor's view without aggregating anything away (§12.1).
  view_session_id   uuid,

  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,

  prev_hash         text NOT NULL,
  row_hash          text NOT NULL,

  CONSTRAINT event_type_known CHECK (event_type IN (
    -- Session
    'LOGIN_OK','LOGIN_FAIL','LOCKOUT','LOGOUT','SESSION_REVOKED','PASSWORD_CHANGED',
    -- Discovery
    'SEARCH','RECORD_METADATA_VIEWED',
    -- Request
    'REQUEST_SUBMITTED','REQUEST_WITHDRAWN','ITEM_APPROVED','ITEM_REJECTED',
    -- Permission
    'GRANT_CREATED','GRANT_REVOKED','GRANT_EXPIRED','EMERGENCY_GRANT_ISSUED',
    -- Authority (§6.2)
    'AUTHORITY_ISSUED','AUTHORITY_SUSPENDED','AUTHORITY_RESUMED','AUTHORITY_REVOKED',
    'AUTHORITY_EXPIRED','DECISION_REFUSED_NO_AUTHORITY',
    -- Content (§4.1 — pages, never files)
    'VIEW_SESSION_OPENED','PAGE_SERVED','PAGE_DENIED','VIEW_SESSION_CLOSED','THUMBNAIL_SERVED',
    -- Custody
    'INGEST_RUN','RECORD_INDEXED','RECORD_SUPERSEDED','QUARANTINE_RESOLVED',
    'METADATA_CORRECTED','INTEGRITY_ALERT',
    -- Administration
    'USER_CREATED','USER_SUSPENDED','ROLE_GRANTED','ROLE_REVOKED','SETTING_CHANGED'
  ))
);

CREATE INDEX access_events_time_idx    ON access_events (occurred_at DESC);
CREATE INDEX access_events_actor_idx   ON access_events (actor_id, occurred_at DESC);
CREATE INDEX access_events_record_idx  ON access_events (service_record_id, occurred_at DESC);
CREATE INDEX access_events_session_idx ON access_events (view_session_id) WHERE view_session_id IS NOT NULL;
-- Denials against sequential ids are the pattern worth alerting on (§6.3).
CREATE INDEX access_events_deny_idx    ON access_events (occurred_at DESC) WHERE outcome = 'DENY';

-- ---------------------------------------------------------------------------
-- Hash chain. An excision performed directly against the database breaks the
-- chain and the nightly verifier notices (§12).
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_chain_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
BEGIN
  -- Serialises appends so the chain has one unambiguous order. Audit write
  -- volume is page views, not transactions, so this is not the bottleneck.
  PERFORM pg_advisory_xact_lock(hashtext('access_events_chain'));

  SELECT row_hash INTO prev FROM access_events ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := coalesce(prev, repeat('0', 64));
  NEW.row_hash := encode(digest(
      NEW.prev_hash
      || '|' || NEW.seq::text
      || '|' || NEW.occurred_at::text
      || '|' || coalesce(NEW.actor_id::text, '')
      || '|' || NEW.event_type
      || '|' || NEW.outcome
      || '|' || coalesce(NEW.service_record_id::text, '')
      || '|' || coalesce(NEW.request_id::text, '')
      || '|' || coalesce(NEW.grant_id::text, '')
      || '|' || coalesce(NEW.authority_id::text, '')
      || '|' || NEW.detail::text,
    'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER access_events_chain
  BEFORE INSERT ON access_events
  FOR EACH ROW EXECUTE FUNCTION audit_chain_link();

-- Append-only, enforced in the table itself rather than only by role grants,
-- so it survives someone connecting as the owner.
CREATE FUNCTION audit_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_events is append-only (%): see design §12', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER access_events_no_update
  BEFORE UPDATE OR DELETE ON access_events
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

-- Nightly verifier (§14 phase 3). Returns the first seq where the chain
-- breaks, or NULL when the log is intact.
CREATE FUNCTION verify_audit_chain(from_seq bigint DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  r          record;
  expected   text := NULL;
BEGIN
  FOR r IN
    SELECT * FROM access_events WHERE seq >= from_seq ORDER BY seq
  LOOP
    IF expected IS NOT NULL AND r.prev_hash <> expected THEN
      RETURN r.seq;
    END IF;
    IF encode(digest(
        r.prev_hash
        || '|' || r.seq::text
        || '|' || r.occurred_at::text
        || '|' || coalesce(r.actor_id::text, '')
        || '|' || r.event_type
        || '|' || r.outcome
        || '|' || coalesce(r.service_record_id::text, '')
        || '|' || coalesce(r.request_id::text, '')
        || '|' || coalesce(r.grant_id::text, '')
        || '|' || coalesce(r.authority_id::text, '')
        || '|' || r.detail::text,
      'sha256'), 'hex') <> r.row_hash THEN
      RETURN r.seq;
    END IF;
    expected := r.row_hash;
  END LOOP;
  RETURN NULL;
END $$;

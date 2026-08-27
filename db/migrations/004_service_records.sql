-- §5.2 The records. Three derived name columns because search lives or dies
-- on them (§7); all three are written by the ingester, never by hand.

CREATE TABLE service_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  ppo_number      text NOT NULL,          -- as parsed, punctuation intact
  ppo_normalized  text NOT NULL,          -- digits only
  employee_name   text NOT NULL,          -- as parsed, never modified
  name_normalized text NOT NULL,          -- uppercased, honorifics stripped
  name_sorted     text NOT NULL,          -- tokens sorted, so word order stops mattering

  file_path       text NOT NULL,          -- treated as untrusted; realpath-guarded on use (§4.2)
  file_name       text NOT NULL,
  sha256          text NOT NULL,
  byte_size       bigint NOT NULL,
  page_count      integer,

  version_no      integer NOT NULL DEFAULT 1,
  superseded_by   uuid REFERENCES service_records(id),
  status          text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','SUPERSEDED','ARCHIVED')),

  source_root     text NOT NULL,
  indexed_at      timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- One live row per file. Superseded versions keep their own rows (§12.2).
CREATE UNIQUE INDEX service_records_sha_idx ON service_records (sha256);

-- PPO branch of search: exact, then prefix (§7).
CREATE INDEX service_records_ppo_idx  ON service_records (ppo_normalized);
CREATE INDEX service_records_ppo_pfx  ON service_records (ppo_normalized text_pattern_ops);

-- Name branch: trigram similarity over both derived forms (§7).
CREATE INDEX service_records_name_trgm
  ON service_records USING gin (name_normalized gin_trgm_ops);
CREATE INDEX service_records_sorted_trgm
  ON service_records USING gin (name_sorted gin_trgm_ops);

-- Old PPO numbers get revised and names get respelled. Aliases keep the old
-- spelling findable without corrupting the primary field (§5.2).
CREATE TABLE record_aliases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_record_id uuid NOT NULL REFERENCES service_records(id),
  alias_kind        text NOT NULL CHECK (alias_kind IN ('PPO','NAME')),
  value_normalized  text NOT NULL,
  source            text NOT NULL,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_record_id, alias_kind, value_normalized)
);
CREATE INDEX record_aliases_value_trgm
  ON record_aliases USING gin (value_normalized gin_trgm_ops);

CREATE TABLE ingestion_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  triggered_by uuid REFERENCES users(id),   -- NULL = scheduled
  files_seen   integer NOT NULL DEFAULT 0,
  added        integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  quarantined  integer NOT NULL DEFAULT 0,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Files the parser could not confidently place. Invisible to search until a
-- human resolves them — ingestion never invents metadata (§8.1).
CREATE TABLE quarantine_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_run_id uuid REFERENCES ingestion_runs(id),
  raw_path       text NOT NULL,
  raw_filename   text NOT NULL,
  sha256         text,
  reason         text NOT NULL CHECK (reason IN
                   ('UNPARSEABLE','PPO_CONFLICT','NEW_VERSION','UNREADABLE','DUPLICATE')),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  suggested_ppo  text,
  suggested_name text,
  resolved_by    uuid REFERENCES users(id),
  resolved_at    timestamptz,
  resolution     text CHECK (resolution IN ('INDEXED','SUPERSEDED','LINKED','IGNORED')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quarantine_open_idx ON quarantine_items (created_at) WHERE resolved_at IS NULL;

-- §5.3. Policy the department can change without a deploy. Note what is NOT
-- here: there is no download flag, because screen-only is structural (§4.1).

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('grant.default_days',        '15'::jsonb),
  ('grant.max_days',            '180'::jsonb),
  ('grant.expiry_warn_days',    '[7, 2]'::jsonb),
  ('authority.expiry_warn_days','[14, 3]'::jsonb),
  ('audit.retention_years',     '8'::jsonb),
  ('render.dpi',                '150'::jsonb),
  ('render.cache_ttl_seconds',  '900'::jsonb),
  ('ppo.standard_length',       '12'::jsonb),
  ('ppo.min_length',            '6'::jsonb),
  ('ppo.max_length',            '14'::jsonb),
  ('search.min_query_length',   '3'::jsonb),
  ('search.similarity_floor',   '0.35'::jsonb);

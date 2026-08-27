-- Trigram matching drives name search (§7). pgcrypto is only needed on PG < 13
-- for gen_random_uuid(); harmless to have.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

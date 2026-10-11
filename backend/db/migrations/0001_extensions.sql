-- 0001_extensions.sql
-- citext: case-insensitive email uniqueness (PRD 8.1).
-- gen_random_uuid() is built into PostgreSQL 13+ core; no pgcrypto/uuid-ossp needed.
CREATE EXTENSION IF NOT EXISTS citext;

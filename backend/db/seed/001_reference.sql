-- 001_reference.sql: controlled genre list (idempotent).
INSERT INTO genres (name) VALUES
  ('Fiction'), ('Science Fiction'), ('Fantasy'), ('Mystery'),
  ('Computer Science'), ('Mathematics'), ('Physics'),
  ('History'), ('Biography'), ('Self-Help'), ('Business'), ('Philosophy')
ON CONFLICT (lower(name)) DO NOTHING;

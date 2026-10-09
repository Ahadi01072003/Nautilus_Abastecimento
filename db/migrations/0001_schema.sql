-- NAUTILUS · Abastecimentos — esquema Postgres (v8).
-- Portado do esquema D1/SQLite da v7. Datas permanecem como texto ISO-8601 UTC
-- (comparação lexicográfica preservada); quantidades em milésimos (bigint).

CREATE TABLE IF NOT EXISTS members (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  email text UNIQUE,
  name text NOT NULL,
  profile text NOT NULL DEFAULT 'requester' CHECK (profile IN ('requester','planner','fueler','manager')),
  notify_requests integer NOT NULL DEFAULT 1 CHECK (notify_requests IN (0,1)),
  notify_schedule integer NOT NULL DEFAULT 1 CHECK (notify_schedule IN (0,1)),
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at text NOT NULL,
  password_hash text NOT NULL,
  must_change_password integer NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  password_changed_at text,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until text,
  last_login_at text
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  last_seen_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS fuels (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  unit text NOT NULL,
  integral integer NOT NULL DEFAULT 0 CHECK (integral IN (0,1)),
  capacity_milli bigint NOT NULL,
  minimum_milli bigint NOT NULL,
  stock_milli bigint NOT NULL,
  lead_days integer NOT NULL,
  provisional integer NOT NULL DEFAULT 1,
  active integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 0,
  CONSTRAINT stock_limits CHECK (stock_milli >= 0 AND stock_milli <= capacity_milli AND minimum_milli >= 0 AND minimum_milli < capacity_milli AND lead_days BETWEEN 1 AND 60)
);

CREATE TABLE IF NOT EXISTS operators (
  id text PRIMARY KEY,
  name text NOT NULL,
  badge text NOT NULL DEFAULT '',
  active integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS equipment (
  id text PRIMARY KEY,
  tag text NOT NULL UNIQUE,
  description text NOT NULL,
  type text NOT NULL,
  fuel_ids text[] NOT NULL,
  active integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS appointments (
  id text PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  equipment_id text NOT NULL REFERENCES equipment(id),
  equipment_tag text NOT NULL,
  equipment_name text NOT NULL,
  fuel_id text NOT NULL REFERENCES fuels(id),
  fuel_name text NOT NULL,
  hourmeter_milli bigint NOT NULL,
  requester_id text NOT NULL REFERENCES members(id),
  requester_name text NOT NULL,
  created_at text NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  scheduled_at text,
  assigned_member_id text REFERENCES members(id),
  assigned_name text,
  scheduled_by_id text REFERENCES members(id),
  scheduled_by_name text,
  updated_at text NOT NULL,
  completed_at text,
  cancel_reason text NOT NULL DEFAULT '',
  cancelled_by_id text REFERENCES members(id),
  cancelled_by_name text,
  version integer NOT NULL DEFAULT 0,
  CONSTRAINT appointment_hourmeter CHECK (hourmeter_milli >= 0),
  CONSTRAINT appointment_status CHECK (status IN ('requested','scheduled','completed','cancelled')),
  CONSTRAINT appointment_schedule CHECK (status NOT IN ('scheduled','completed') OR scheduled_at IS NOT NULL),
  CONSTRAINT appointment_completed CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_appointments_created ON appointments(created_at);
CREATE INDEX IF NOT EXISTS idx_appointments_status_schedule ON appointments(status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_equipment_time ON appointments(equipment_id, scheduled_at) WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS supplies (
  id text PRIMARY KEY,
  appointment_id text REFERENCES appointments(id),
  operation_key text NOT NULL UNIQUE,
  fuel_id text NOT NULL REFERENCES fuels(id),
  equipment_id text NOT NULL REFERENCES equipment(id),
  operator_id text NOT NULL REFERENCES operators(id),
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  occurred_at text NOT NULL,
  created_at text NOT NULL,
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  equipment_tag text NOT NULL,
  equipment_name text NOT NULL,
  operator_name text NOT NULL,
  fuel_name text NOT NULL,
  unit text NOT NULL,
  hourmeter_milli bigint,
  hourmeter_end_milli bigint,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  cancel_reason text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supply_active_appointment ON supplies(appointment_id) WHERE appointment_id IS NOT NULL AND status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_supplies_date ON supplies(occurred_at);
CREATE INDEX IF NOT EXISTS idx_supplies_fuel_date ON supplies(fuel_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_supplies_author ON supplies(author_id, occurred_at);

CREATE TABLE IF NOT EXISTS requests (
  id text PRIMARY KEY,
  fuel_id text NOT NULL REFERENCES fuels(id),
  requested_milli bigint NOT NULL,
  received_milli bigint NOT NULL DEFAULT 0,
  stock_reference_milli bigint NOT NULL,
  opened_at text NOT NULL,
  deadline text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','purchasing','partial','received','cancelled')),
  CONSTRAINT request_received CHECK (received_milli >= 0 AND received_milli <= requested_milli AND requested_milli > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_request_active_fuel ON requests(fuel_id) WHERE status IN ('open','purchasing','partial');

CREATE TABLE IF NOT EXISTS movements (
  id text PRIMARY KEY,
  operation_key text NOT NULL UNIQUE,
  fuel_id text NOT NULL REFERENCES fuels(id),
  delta_milli bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('initial','debit','receipt','adjustment','reversal')),
  supply_id text REFERENCES supplies(id),
  request_id text REFERENCES requests(id),
  balance_after_milli bigint,
  expected_version integer,
  occurred_at text NOT NULL,
  author_id text NOT NULL REFERENCES members(id),
  author_name text NOT NULL,
  reason text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_fuel_date ON movements(fuel_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_movements_date ON movements(occurred_at);

CREATE TABLE IF NOT EXISTS audits (
  id text PRIMARY KEY,
  action text NOT NULL,
  entity_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL,
  created_at text NOT NULL,
  detail text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audits_created ON audits(created_at);

CREATE TABLE IF NOT EXISTS holidays (
  date text PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_events (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('requested','scheduled','completed','minimum','cancelled')),
  entity_type text NOT NULL CHECK (entity_type IN ('appointments','supplies','requests')),
  entity_id text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES notification_events(id),
  member_id text NOT NULL REFERENCES members(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  locked_at text,
  sent_at text,
  last_error text NOT NULL DEFAULT '',
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_event_member ON notifications(event_id, member_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  hits integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_window ON rate_limits(window_start);

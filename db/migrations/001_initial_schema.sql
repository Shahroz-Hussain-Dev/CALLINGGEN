-- ============================================================================
-- LATechS Sales OS - Initial schema
-- Target: Supabase PostgreSQL (PostgreSQL 15+). Safe to re-run (IF NOT EXISTS).
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL,
  username_normalized text GENERATED ALWAYS AS (lower(btrim(username))) STORED,
  display_name        text NOT NULL,
  password_hash       text NOT NULL,
  role                text NOT NULL CHECK (role IN ('employee', 'owner')),
  account_status      text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'disabled')),
  api_key_reference   uuid NULL,
  rotation_order      integer NOT NULL,
  participates_in_rotation boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at       timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_normalized_uidx ON users (username_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS users_rotation_order_uidx ON users (rotation_order);
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- SESSIONS (server-side sessions; browser only holds an opaque token cookie)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz NULL,
  ip_address   text NULL,
  user_agent   text NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- USER API KEYS (encrypted at rest with APP_ENCRYPTION_KEY; never returned)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_api_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'anthropic',
  encrypted_key    text NOT NULL,
  key_last4        text NOT NULL,
  status           text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'valid', 'invalid')),
  last_tested_at   timestamptz NULL,
  last_test_result jsonb NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_api_keys_user_provider_uidx ON user_api_keys (user_id, provider);
DROP TRIGGER IF EXISTS user_api_keys_set_updated_at ON user_api_keys;
CREATE TRIGGER user_api_keys_set_updated_at BEFORE UPDATE ON user_api_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- NICHES (editable reference data; admin can add more without code changes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS niches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  panel       text NOT NULL CHECK (panel IN ('strategy', 'service')),
  category    text NULL,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS niches_panel_name_uidx ON niches (panel, lower(name));
DROP TRIGGER IF EXISTS niches_set_updated_at ON niches;
CREATE TRIGGER niches_set_updated_at BEFORE UPDATE ON niches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- SYSTEM SETTINGS (key/value, admin editable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- ROTATION STATE (single row) + RUNS (idempotency / audit)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rotation_state (
  id                   integer PRIMARY KEY CHECK (id = 1),
  current_cycle_number integer NOT NULL DEFAULT 1,
  cycle_started_at     timestamptz NULL,
  next_rotation_at     timestamptz NULL,
  last_rotation_at     timestamptz NULL,
  last_rotation_run_id uuid NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO rotation_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rotation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_number   integer NOT NULL,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
  trigger_source text NOT NULL DEFAULT 'manual' CHECK (trigger_source IN ('cron', 'manual', 'test')),
  triggered_by   uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz NULL,
  lists_rotated  integer NOT NULL DEFAULT 0,
  lists_completed integer NOT NULL DEFAULT 0,
  lists_created  integer NOT NULL DEFAULT 0,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error          text NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rotation_runs_cycle_completed_uidx ON rotation_runs (cycle_number) WHERE status = 'completed';

-- ---------------------------------------------------------------------------
-- CONTACT LISTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_lists (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_name           text NOT NULL,
  list_code           text NOT NULL,
  contact_type        text NOT NULL CHECK (contact_type IN ('strategy', 'service')),
  current_owner_id    uuid NOT NULL REFERENCES users(id),
  original_owner_id   uuid NOT NULL REFERENCES users(id),
  creation_date       timestamptz NOT NULL DEFAULT now(),
  rotation_date       timestamptz NULL,
  last_rotated_at     timestamptz NULL,
  cycle_number        integer NOT NULL,
  last_rotated_cycle  integer NULL,
  rotation_count      integer NOT NULL DEFAULT 0,
  list_status         text NOT NULL DEFAULT 'generating' CHECK (list_status IN ('generating', 'active', 'completed', 'archived')),
  selected_niches     jsonb NOT NULL DEFAULT '[]'::jsonb,
  generation_progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_size         integer NOT NULL DEFAULT 50 CHECK (target_size BETWEEN 1 AND 50),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_lists_code_uidx ON contact_lists (list_code);
-- One list per owner / panel / cycle (idempotent creation after rotation)
CREATE UNIQUE INDEX IF NOT EXISTS contact_lists_origin_cycle_uidx ON contact_lists (original_owner_id, contact_type, cycle_number);
CREATE INDEX IF NOT EXISTS contact_lists_owner_idx ON contact_lists (current_owner_id, contact_type, list_status);
DROP TRIGGER IF EXISTS contact_lists_set_updated_at ON contact_lists;
CREATE TRIGGER contact_lists_set_updated_at BEFORE UPDATE ON contact_lists FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- GENERATION JOBS (batch lead generation; resumable + idempotent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id                  uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  requested_by             uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  contact_type             text NOT NULL CHECK (contact_type IN ('strategy', 'service')),
  requested_count          integer NOT NULL,
  saved_count              integer NOT NULL DEFAULT 0,
  duplicate_count          integer NOT NULL DEFAULT 0,
  rejected_count           integer NOT NULL DEFAULT 0,
  needs_verification_count integer NOT NULL DEFAULT 0,
  verified_count           integer NOT NULL DEFAULT 0,
  attempts                 integer NOT NULL DEFAULT 0,
  empty_attempts           integer NOT NULL DEFAULT 0,
  status                   text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'exhausted', 'failed', 'cancelled')),
  last_error               text NULL,
  last_batch_at            timestamptz NULL,
  locked_at                timestamptz NULL,
  lock_token               text NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_jobs_list_idx ON generation_jobs (list_id);
CREATE INDEX IF NOT EXISTS generation_jobs_status_idx ON generation_jobs (status);
DROP TRIGGER IF EXISTS generation_jobs_set_updated_at ON generation_jobs;
CREATE TRIGGER generation_jobs_set_updated_at BEFORE UPDATE ON generation_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- CONTACTS (global business registry - one row per unique business, ever)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name             text NOT NULL,
  normalized_business_name  text NOT NULL,
  industry                  text NULL,
  niche                     text NULL,
  niche_id                  uuid NULL REFERENCES niches(id) ON DELETE SET NULL,
  business_description      text NULL,
  website                   text NULL,
  normalized_website_domain text NULL,
  website_available         boolean NULL,
  phone                     text NULL,
  normalized_phone          text NULL,
  public_email              text NULL,
  address                   text NULL,
  city                      text NULL,
  country                   text NOT NULL DEFAULT 'Pakistan',
  social_profiles           jsonb NOT NULL DEFAULT '{}'::jsonb,
  company_size              text NULL,
  employee_count_estimate   text NULL,
  business_locations        jsonb NOT NULL DEFAULT '[]'::jsonb,
  departments               jsonb NOT NULL DEFAULT '[]'::jsonb,
  management_data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_makers           jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_type              text NOT NULL CHECK (contact_type IN ('strategy', 'service')),
  contact_list_id           uuid NULL REFERENCES contact_lists(id) ON DELETE SET NULL,
  current_owner_id          uuid NULL REFERENCES users(id),
  original_owner_id         uuid NULL REFERENCES users(id),
  contact_status            text NOT NULL DEFAULT 'not_called' CHECK (contact_status IN (
                              'not_called', 'no_answer', 'call_back_later', 'interested', 'not_interested',
                              'meeting_booked', 'wrong_number', 'business_closed', 'follow_up_required')),
  interest_level            text NULL CHECK (interest_level IS NULL OR interest_level IN (
                              'interested', 'not_interested', 'maybe_follow_up', 'meeting_requested',
                              'meeting_booked', 'no_clear_interest')),
  business_operations       jsonb NOT NULL DEFAULT '{}'::jsonb,
  automation_opportunities  jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes                     text NULL,
  follow_up_date            date NULL,
  meeting_status            text NOT NULL DEFAULT 'none' CHECK (meeting_status IN ('none', 'requested', 'booked', 'completed', 'cancelled')),
  data_status               text NOT NULL DEFAULT 'needs_verification' CHECK (data_status IN ('verified', 'partially_verified', 'estimated', 'needs_verification')),
  field_verification        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_urls               jsonb NOT NULL DEFAULT '[]'::jsonb,
  generation_source         text NULL,
  generation_timestamp      timestamptz NULL,
  generation_job_id         uuid NULL REFERENCES generation_jobs(id) ON DELETE SET NULL,
  processed_cycle           integer NULL,
  last_processed_at         timestamptz NULL,
  last_call_at              timestamptz NULL,
  call_count                integer NOT NULL DEFAULT 0,
  skip_reason               text NULL,
  is_demo                   boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
-- Global duplicate prevention (enforced by the database, not only by code)
CREATE UNIQUE INDEX IF NOT EXISTS contacts_normalized_phone_uidx
  ON contacts (normalized_phone) WHERE normalized_phone IS NOT NULL AND normalized_phone <> '';
CREATE UNIQUE INDEX IF NOT EXISTS contacts_normalized_domain_uidx
  ON contacts (normalized_website_domain) WHERE normalized_website_domain IS NOT NULL AND normalized_website_domain <> '';
CREATE UNIQUE INDEX IF NOT EXISTS contacts_name_city_uidx
  ON contacts (normalized_business_name, COALESCE(lower(btrim(city)), ''));
CREATE INDEX IF NOT EXISTS contacts_owner_idx ON contacts (current_owner_id, contact_type);
CREATE INDEX IF NOT EXISTS contacts_list_idx ON contacts (contact_list_id);
CREATE INDEX IF NOT EXISTS contacts_status_idx ON contacts (contact_status);
CREATE INDEX IF NOT EXISTS contacts_niche_idx ON contacts (niche);
CREATE INDEX IF NOT EXISTS contacts_city_idx ON contacts (lower(city));
CREATE INDEX IF NOT EXISTS contacts_follow_up_idx ON contacts (follow_up_date) WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_name_search_idx ON contacts (normalized_business_name text_pattern_ops);
DROP TRIGGER IF EXISTS contacts_set_updated_at ON contacts;
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- LIST <-> CONTACT relationship (ordered)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS list_contacts (
  list_id    uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position   integer NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS list_contacts_position_uidx ON list_contacts (list_id, position);
CREATE INDEX IF NOT EXISTS list_contacts_contact_idx ON list_contacts (contact_id);

-- ---------------------------------------------------------------------------
-- GENERATION REJECTIONS (audit of duplicates / invalid candidates)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS generation_rejections (
  id                 bigserial PRIMARY KEY,
  job_id             uuid NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  list_id            uuid NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  business_name      text NOT NULL,
  normalized_name    text NULL,
  reason             text NOT NULL,
  matched_contact_id uuid NULL REFERENCES contacts(id) ON DELETE SET NULL,
  details            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_rejections_job_idx ON generation_rejections (job_id);

-- ---------------------------------------------------------------------------
-- CALL RECORDS (permanent history)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id           uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES users(id),
  list_id              uuid NULL REFERENCES contact_lists(id) ON DELETE SET NULL,
  call_datetime        timestamptz NOT NULL DEFAULT now(),
  person_contacted     text NULL,
  person_designation   text NULL,
  call_status          text NOT NULL CHECK (call_status IN (
                         'not_called', 'no_answer', 'call_back_later', 'interested', 'not_interested',
                         'meeting_booked', 'wrong_number', 'business_closed', 'follow_up_required')),
  conversation_summary text NULL,
  customer_response    text NULL,
  interest_level       text NULL CHECK (interest_level IS NULL OR interest_level IN (
                         'interested', 'not_interested', 'maybe_follow_up', 'meeting_requested',
                         'meeting_booked', 'no_clear_interest')),
  services_discussed   text NULL,
  problems_identified  text NULL,
  objections           text NULL,
  follow_up_required   boolean NOT NULL DEFAULT false,
  next_follow_up_date  date NULL,
  meeting_required     boolean NOT NULL DEFAULT false,
  additional_notes     text NULL,
  panel_fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
  skipped              boolean NOT NULL DEFAULT false,
  skip_reason          text NULL,
  cycle_number         integer NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS call_records_contact_idx ON call_records (contact_id, call_datetime);
CREATE INDEX IF NOT EXISTS call_records_employee_idx ON call_records (employee_id, call_datetime);
CREATE INDEX IF NOT EXISTS call_records_status_idx ON call_records (call_status);

-- ---------------------------------------------------------------------------
-- FOLLOW-UPS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follow_ups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  call_record_id    uuid NULL REFERENCES call_records(id) ON DELETE SET NULL,
  owner_id          uuid NOT NULL REFERENCES users(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  previous_owner_id uuid NULL REFERENCES users(id),
  contact_person    text NULL,
  follow_up_date    date NOT NULL,
  follow_up_time    time NULL,
  reason            text NULL,
  notes             text NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rescheduled', 'cancelled')),
  completed_at      timestamptz NULL,
  rescheduled_to_id uuid NULL REFERENCES follow_ups(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS follow_ups_owner_date_idx ON follow_ups (owner_id, follow_up_date, status);
CREATE INDEX IF NOT EXISTS follow_ups_contact_idx ON follow_ups (contact_id);
DROP TRIGGER IF EXISTS follow_ups_set_updated_at ON follow_ups;
CREATE TRIGGER follow_ups_set_updated_at BEFORE UPDATE ON follow_ups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- MEETINGS (shared calendar; overlap prevented by an exclusion constraint)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_contact_id uuid NULL REFERENCES contacts(id) ON DELETE SET NULL,
  meeting_owner_id    uuid NOT NULL REFERENCES users(id),
  created_by          uuid NOT NULL REFERENCES users(id),
  business_name       text NOT NULL,
  meeting_type        text NOT NULL CHECK (meeting_type IN (
                        'website_development', 'automation_sales', 'senior_management', 'follow_up', 'other')),
  meeting_date        date NOT NULL,
  start_time          time NOT NULL,
  end_time            time NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  meeting_status      text NOT NULL DEFAULT 'scheduled' CHECK (meeting_status IN (
                        'scheduled', 'completed', 'cancelled', 'rescheduled', 'no_show')),
  contact_person      text NULL,
  phone_number        text NULL,
  location            text NULL,
  online_link         text NULL,
  notes               text NULL,
  outcome             jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key     text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meetings_time_order_chk CHECK (ends_at > starts_at)
);
-- Team-wide: two active meetings can never overlap. Enforced atomically by PostgreSQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_no_overlap_excl') THEN
    ALTER TABLE meetings ADD CONSTRAINT meetings_no_overlap_excl
      EXCLUDE USING gist (tstzrange(starts_at, ends_at, '[)') WITH &&)
      WHERE (meeting_status IN ('scheduled', 'rescheduled'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS meetings_idempotency_uidx ON meetings (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS meetings_date_idx ON meetings (meeting_date);
CREATE INDEX IF NOT EXISTS meetings_owner_idx ON meetings (meeting_owner_id);
CREATE INDEX IF NOT EXISTS meetings_contact_idx ON meetings (business_contact_id);
DROP TRIGGER IF EXISTS meetings_set_updated_at ON meetings;
CREATE TRIGGER meetings_set_updated_at BEFORE UPDATE ON meetings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- LEAD RESEARCH (Claude-generated business profiles / meeting prep, versioned)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_research (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('business_profile', 'meeting_prep', 'automation_analysis', 'booking_analysis')),
  content     jsonb NOT NULL,
  model       text NULL,
  source_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by  uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_research_contact_idx ON lead_research (contact_id, kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- ACTIVITY LOGS (audit trail)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id         bigserial PRIMARY KEY,
  user_id    uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  contact_id uuid NULL REFERENCES contacts(id) ON DELETE SET NULL,
  list_id    uuid NULL REFERENCES contact_lists(id) ON DELETE SET NULL,
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  details    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS activity_logs_user_idx ON activity_logs (user_id, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS activity_logs_action_idx ON activity_logs (action, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS activity_logs_contact_idx ON activity_logs (contact_id);

-- ---------------------------------------------------------------------------
-- USER SETTINGS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_settings (
  user_id                     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_strategy_niches    jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_service_niches     jsonb NOT NULL DEFAULT '[]'::jsonb,
  lead_generation_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  api_key_reference           uuid NULL REFERENCES user_api_keys(id) ON DELETE SET NULL,
  notification_preferences    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS user_settings_set_updated_at ON user_settings;
CREATE TRIGGER user_settings_set_updated_at BEFORE UPDATE ON user_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ROTATION HISTORY
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rotation_history (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id           uuid NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
  previous_owner_id uuid NOT NULL REFERENCES users(id),
  new_owner_id      uuid NULL REFERENCES users(id),
  rotation_date     timestamptz NOT NULL DEFAULT now(),
  cycle_number      integer NOT NULL,
  rotation_run_id   uuid NULL REFERENCES rotation_runs(id) ON DELETE SET NULL,
  event_type        text NOT NULL DEFAULT 'rotated' CHECK (event_type IN ('rotated', 'completed', 'manual_transfer')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rotation_history_list_cycle_uidx ON rotation_history (list_id, cycle_number) WHERE event_type IN ('rotated', 'completed');
CREATE INDEX IF NOT EXISTS rotation_history_list_idx ON rotation_history (list_id, rotation_date);

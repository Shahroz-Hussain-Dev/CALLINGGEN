-- Lead targeting criteria snapshot per list (stage, founding year, team size, leadership preference).
-- The global default lives in system_settings under the key lead_criteria.
ALTER TABLE contact_lists ADD COLUMN IF NOT EXISTS criteria jsonb NOT NULL DEFAULT '{}'::jsonb;

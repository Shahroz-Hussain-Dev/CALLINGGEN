-- Sell-probability scoring, niche coverage tracking and clinic niches for the Strategy panel.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sell_score numeric(5,2) NULL; -- 0-100 probability of a sale (Strategy panel)
CREATE INDEX IF NOT EXISTS contacts_sell_score_idx ON contacts (contact_type, sell_score DESC NULLS LAST);

-- Per-list coverage of niche x city combinations: attempts, saved leads and exhaustion, used to pick the
-- next target and to switch niche when one is exhausted nationwide.
ALTER TABLE contact_lists ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO niches (panel, category, name, sort_order) VALUES
  ('strategy', 'Clinics & Doctors', 'Newly Opened Doctor Clinics', 40),
  ('strategy', 'Clinics & Doctors', 'Dental Clinics', 41),
  ('strategy', 'Clinics & Doctors', 'Dermatology and Skin Clinics', 42),
  ('strategy', 'Clinics & Doctors', 'Gynecology and Women''s Health Clinics', 43),
  ('strategy', 'Clinics & Doctors', 'Pediatric Clinics', 44),
  ('strategy', 'Clinics & Doctors', 'Physiotherapy Clinics', 45),
  ('strategy', 'Clinics & Doctors', 'Eye Clinics and Optometrists', 46),
  ('strategy', 'Clinics & Doctors', 'Homeopathic and Hikmat Clinics', 47),
  ('strategy', 'Clinics & Doctors', 'Nutritionist and Diet Clinics', 48),
  ('strategy', 'Clinics & Doctors', 'Psychologist and Counselling Practices', 49),
  ('strategy', 'Clinics & Doctors', 'Diagnostic Labs and Collection Points', 50),
  ('strategy', 'Clinics & Doctors', 'Veterinary Clinics', 51)
ON CONFLICT DO NOTHING;

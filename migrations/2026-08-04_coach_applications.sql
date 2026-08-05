-- ══════════════════════════════════════════════════════════════════════
--  Coach Applications — additive migration (PROPOSED, DO NOT APPLY)
-- ══════════════════════════════════════════════════════════════════════
--
--  Stores coach-application data separately from authorization.
--  Selecting "I'm a coach" during onboarding inserts a row here with
--  status = 'pending'. An admin reviews and approves/rejects.
--
--  ONLY after approval should a separate admin action set
--  profiles.role = 'coach'. This table never grants role access.
--
--  ⚠️  DO NOT APPLY THIS MIGRATION AUTOMATICALLY.
--  Review, test in staging, and apply through your standard migration
--  process.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS coach_applications (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
  coaching_brand  text,
  coaching_sports text,           -- comma-separated list
  experience_band text
                    CHECK (experience_band IS NULL OR experience_band IN (
                      'new', 'under_2', '2_5', '5_plus'
                    )),
  athlete_count_band text
                    CHECK (athlete_count_band IS NULL OR athlete_count_band IN (
                      '0', '1_5', '6_15', '16_30', '31_plus'
                    )),
  coaching_setup  text
                    CHECK (coaching_setup IS NULL OR coaching_setup IN (
                      'online', 'in_person', 'hybrid'
                    )),
  created_at      timestamptz DEFAULT now() NOT NULL,
  reviewed_at     timestamptz,
  reviewed_by     uuid REFERENCES profiles(id)
);

-- One pending application per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_applications_pending
  ON coach_applications (user_id)
  WHERE status = 'pending';

-- Index for admin review queue.
CREATE INDEX IF NOT EXISTS idx_coach_applications_status
  ON coach_applications (status, created_at);

-- ── Row Level Security ──────────────────────────────────────────────
--
-- Enforces every security correction from the approved spec:
--   · user_id must equal auth.uid() on insert
--   · status must be 'pending' on insert (CHECK + policy)
--   · reviewed_at and reviewed_by must remain null on insert
--   · applicants may select only their own application
--   · applicants may update only non-authority fields of their own
--     pending application (never status, reviewed_at, reviewed_by)
--   · applicants may not insert for another user
--   · no client policy for approval or rejection
--   · service_role bypasses RLS for admin review tooling

ALTER TABLE coach_applications ENABLE ROW LEVEL SECURITY;

-- INSERT: own row only, forced pending, no authority fields.
CREATE POLICY coach_applications_insert_own ON coach_applications
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND status = 'pending'
    AND reviewed_at IS NULL
    AND reviewed_by IS NULL
  );

-- SELECT: own rows only.
CREATE POLICY coach_applications_select_own ON coach_applications
  FOR SELECT USING (auth.uid() = user_id);

-- UPDATE: own pending application only, cannot change authority fields.
-- The WITH CHECK ensures post-update state is still valid: status stays
-- pending, reviewed_at/reviewed_by stay null. Only coaching_brand,
-- coaching_sports, experience_band, athlete_count_band, coaching_setup
-- can change (the columns not checked here).
CREATE POLICY coach_applications_update_own ON coach_applications
  FOR UPDATE USING (
    auth.uid() = user_id
    AND status = 'pending'
  ) WITH CHECK (
    auth.uid() = user_id
    AND status = 'pending'
    AND reviewed_at IS NULL
    AND reviewed_by IS NULL
  );

-- DELETE: applicants cannot delete their own applications.
-- (No DELETE policy = deny all for authenticated users.)

-- Admin/service-role policies would be added as part of the admin review
-- tooling. service_role bypasses RLS by default, so admin tools can
-- update status, set reviewed_at/reviewed_by, and read all rows.

COMMENT ON TABLE coach_applications IS
  'Coach onboarding applications. status controls visibility only — '
  'profiles.role is the sole authorization source for Coach Workspace.';

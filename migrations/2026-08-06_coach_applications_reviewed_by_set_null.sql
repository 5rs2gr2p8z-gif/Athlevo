/*
 * ══════════════════════════════════════════════════════════════════════
 *  Migration: coach_applications.reviewed_by FK → ON DELETE SET NULL
 * ══════════════════════════════════════════════════════════════════════
 *
 *  The existing foreign key on coach_applications.reviewed_by → profiles.id
 *  uses NO ACTION, which would block deletion of a profile that has reviewed
 *  coach applications. This migration changes it to SET NULL so that when a
 *  reviewer's account is deleted, the application row is preserved but the
 *  reviewer reference is cleared.
 *
 *  This does NOT add cascade FKs across all legacy tables — that is deferred
 *  to a future sprint.
 *
 *  DO NOT APPLY without reviewing in a staging environment first.
 *
 *  Created: 2026-08-06
 *  Context: Account deletion feature
 */

-- Drop the existing FK constraint and re-add with ON DELETE SET NULL.
-- The constraint name is derived from the standard Supabase/Postgres naming.

ALTER TABLE public.coach_applications
  DROP CONSTRAINT IF EXISTS coach_applications_reviewed_by_fkey;

ALTER TABLE public.coach_applications
  ADD CONSTRAINT coach_applications_reviewed_by_fkey
  FOREIGN KEY (reviewed_by)
  REFERENCES public.profiles(id)
  ON DELETE SET NULL;

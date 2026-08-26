-- Atomic server-side usage counter used by AI abuse limits and the free
-- Coach allowance. This function was referenced by application code but was
-- not present in the production schema, causing every allowance acquisition
-- to fail with PostgREST PGRST202 and surface as ACCESS_UNAVAILABLE.

CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_user_id uuid,
  p_endpoint text,
  p_window_start timestamptz,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR
      p_endpoint IS NULL OR
      length(p_endpoint) < 1 OR
      length(p_endpoint) > 80 OR
      p_window_start IS NULL OR
      p_limit < 1 OR
      p_limit > 10000 THEN
    RAISE EXCEPTION 'invalid rate-limit input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ai_rate_limits (
    user_id,
    endpoint,
    window_start,
    request_count,
    updated_at
  ) VALUES (
    p_user_id,
    p_endpoint,
    p_window_start,
    1,
    now()
  )
  ON CONFLICT (user_id, endpoint, window_start)
  DO UPDATE SET
    request_count = ai_rate_limits.request_count + 1,
    updated_at = now()
  RETURNING request_count INTO v_count;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_limit,
    'current_count', v_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.increment_rate_limit(
  uuid, text, timestamptz, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.increment_rate_limit(
  uuid, text, timestamptz, integer
) TO service_role;

COMMENT ON FUNCTION public.increment_rate_limit(
  uuid, text, timestamptz, integer
) IS 'Atomically increments a per-user fixed-window usage counter and returns whether it remains within the supplied limit.';

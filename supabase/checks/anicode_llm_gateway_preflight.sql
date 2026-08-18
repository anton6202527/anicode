-- Read-only production gate after both migrations and before deploying the v2 Edge Function.
-- Any missing signature or privilege aborts the deployment command via ON_ERROR_STOP semantics.
do $$
declare
  application_role text;
  function_signature text;
begin
  if pg_catalog.to_regprocedure(
       'public.reclaim_anicode_llm_stale_requests_v2()'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.settle_anicode_llm_request_v2(uuid,integer,text,integer,integer,integer,integer,integer)'
     ) is null then
    raise exception 'AniCode gateway v2 RPC contract is incomplete';
  end if;

  if not pg_catalog.has_function_privilege(
       'service_role',
       'public.reclaim_anicode_llm_stale_requests_v2()',
       'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)',
       'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.settle_anicode_llm_request_v2(uuid,integer,text,integer,integer,integer,integer,integer)',
       'execute'
     ) then
    raise exception 'AniCode gateway v2 RPCs are not executable by service_role';
  end if;

  foreach application_role in array array['anon', 'authenticated'] loop
    foreach function_signature in array array[
      'public.reclaim_anicode_llm_stale_requests_v2()',
      'public.reserve_anicode_llm_request_v2(uuid,text,uuid,integer,text)',
      'public.settle_anicode_llm_request_v2(uuid,integer,text,integer,integer,integer,integer,integer)'
    ] loop
      if pg_catalog.has_function_privilege(
        application_role,
        function_signature,
        'execute'
      ) then
        raise exception 'AniCode gateway RPC % is exposed to %',
          function_signature,
          application_role;
      end if;
    end loop;
  end loop;
end;
$$;

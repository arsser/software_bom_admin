--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public,extensions', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 兼容 seed.sql 中对 gen_salt/crypt 的直接调用（不依赖 search_path 包含 extensions）
CREATE OR REPLACE FUNCTION public.gen_salt(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT extensions.gen_salt($1);
$$;

CREATE OR REPLACE FUNCTION public.crypt(text, text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT extensions.crypt($1, $2);
$$;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: bom_download_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bom_download_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled'
);


--
-- Name: bom_row_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bom_row_status AS ENUM (
    'pending',
    'await_manual_download',
    'local_found',
    'verified_ok',
    'verified_fail',
    'synced_or_skipped',
    'error'
);


--
-- Name: TYPE bom_row_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.bom_row_status IS 'BOM 行业务状态：pending=待处理, await_manual_download=待人工下载, local_found=本地已发现, verified_ok=校验通过, verified_fail=校验失败, synced_or_skipped=已转存或跳过, error=异常';


--
-- Name: bom_scan_job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bom_scan_job_status AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
);


--
-- Name: bom_batch_product_must_belong_to_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_batch_product_must_belong_to_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM products p
    WHERE p.id = NEW.product_id AND p.user_id = NEW.user_id
  ) INTO ok;

  IF NOT ok THEN
    RAISE EXCEPTION 'Invalid product_id for user';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: bom_cancel_download_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_cancel_download_job(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- queued → cancelled
  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = '用户取消排队',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'queued'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested already true → worker 未响应，强制 cancelled
  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = COALESCE(j.last_message, '') || '（用户强制取消）',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL,
      running_file_name = NULL,
      running_bytes_downloaded = 0,
      running_bytes_total = NULL
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = true
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested=false → 首次请求取消
  UPDATE bom_download_jobs j
  SET cancel_requested = true,
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = false
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- failed → cancelled
  UPDATE bom_download_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL,
      running_file_name = NULL,
      running_bytes_downloaded = 0,
      running_bytes_total = NULL
  WHERE j.id = p_job_id
    AND j.status = 'failed'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- succeeded / cancelled → 幂等 true
  RETURN EXISTS (
    SELECT 1
    FROM bom_download_jobs j
    WHERE j.id = p_job_id
      AND j.status IN ('succeeded'::bom_download_job_status, 'cancelled'::bom_download_job_status)
      AND EXISTS (
        SELECT 1 FROM bom_batches b
        WHERE b.id = j.batch_id AND b.user_id = v_user
      )
  );
END;
$$;


--
-- Name: FUNCTION bom_cancel_download_job(p_job_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_cancel_download_job(p_job_id uuid) IS '取消排队；running 首次打标 cancel_requested，二次强制 cancelled；failed 关闭为 cancelled；succeeded/cancelled 幂等';


--
-- Name: bom_cancel_ext_sync_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_cancel_ext_sync_job(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- queued → cancelled
  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = '用户取消排队',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'queued'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested already true → 强制 cancelled
  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      finished_at = NOW(),
      last_message = COALESCE(j.last_message, '') || '（用户强制取消）',
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = true
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- running + cancel_requested=false → 首次请求取消
  UPDATE bom_ext_sync_jobs j
  SET cancel_requested = true,
      updated_at = NOW()
  WHERE j.id = p_job_id
    AND j.status = 'running'::bom_download_job_status
    AND j.cancel_requested = false
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- failed → cancelled
  UPDATE bom_ext_sync_jobs j
  SET status = 'cancelled'::bom_download_job_status,
      updated_at = NOW(),
      cancel_requested = false,
      running_row_id = NULL
  WHERE j.id = p_job_id
    AND j.status = 'failed'::bom_download_job_status
    AND EXISTS (
      SELECT 1 FROM bom_batches b
      WHERE b.id = j.batch_id AND b.user_id = v_user
    );

  IF FOUND THEN
    RETURN TRUE;
  END IF;

  -- succeeded / cancelled → 幂等 true
  RETURN EXISTS (
    SELECT 1
    FROM bom_ext_sync_jobs j
    WHERE j.id = p_job_id
      AND j.status IN ('succeeded'::bom_download_job_status, 'cancelled'::bom_download_job_status)
      AND EXISTS (
        SELECT 1 FROM bom_batches b
        WHERE b.id = j.batch_id AND b.user_id = v_user
      )
  );
END;
$$;


--
-- Name: FUNCTION bom_cancel_ext_sync_job(p_job_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_cancel_ext_sync_job(p_job_id uuid) IS '取消排队；running 首次打标 cancel_requested，二次强制 cancelled；failed 关闭为 cancelled；succeeded/cancelled 幂等';


--
-- Name: bom_claim_download_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_claim_download_job() RETURNS TABLE(id uuid, batch_id uuid, row_ids uuid[], progress_total integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  picked UUID;
BEGIN
  SELECT j2.id
  INTO picked
  FROM bom_download_jobs j2
  WHERE j2.status = 'queued'::bom_download_job_status
  ORDER BY j2.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE bom_download_jobs j
  SET status = 'running'::bom_download_job_status,
      updated_at = NOW(),
      started_at = COALESCE(j.started_at, NOW()),
      heartbeat_at = NOW()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.row_ids, j.progress_total
  FROM bom_download_jobs j
  WHERE j.id = picked;
END;
$$;


--
-- Name: FUNCTION bom_claim_download_job(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_claim_download_job() IS 'worker 抢占一条排队中的拉取任务（service_role）；写入 started_at/heartbeat_at';


--
-- Name: bom_claim_ext_sync_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_claim_ext_sync_job() RETURNS TABLE(id uuid, batch_id uuid, row_ids uuid[], progress_total integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  picked UUID;
BEGIN
  SELECT j2.id
  INTO picked
  FROM bom_ext_sync_jobs j2
  WHERE j2.status = 'queued'::bom_download_job_status
  ORDER BY j2.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF picked IS NULL THEN
    RETURN;
  END IF;

  UPDATE bom_ext_sync_jobs j
  SET status = 'running'::bom_download_job_status,
      updated_at = NOW(),
      started_at = COALESCE(j.started_at, NOW()),
      heartbeat_at = NOW()
  WHERE j.id = picked;

  RETURN QUERY
  SELECT j.id, j.batch_id, j.row_ids, j.progress_total
  FROM bom_ext_sync_jobs j
  WHERE j.id = picked;
END;
$$;


--
-- Name: bom_dashboard_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_dashboard_stats() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'bom_batch_count', (SELECT count(*)::int FROM bom_batches),
    'bom_row_count', (SELECT count(*)::int FROM bom_rows),
    'local_file_count', (SELECT count(*)::int FROM local_file),
    'local_distinct_md5', (
      SELECT count(DISTINCT lower(trim(md5)))::int
      FROM local_file
      WHERE md5 IS NOT NULL AND length(trim(md5)) = 32
    ),
    'local_total_bytes', COALESCE(
      (SELECT sum(size_bytes)::bigint FROM local_file WHERE size_bytes IS NOT NULL),
      0
    ),
    'rows_ext_synced', (
      SELECT count(*)::int FROM bom_rows WHERE (status->>'ext') = 'synced_or_skipped'
    )
  );
$$;


--
-- Name: FUNCTION bom_dashboard_stats(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_dashboard_stats() IS 'BOM 仪表盘：批次/行/本地索引/ext 完成行等汇总';


--
-- Name: bom_extract_download_url(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_extract_download_url(p_row jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  cfg JSONB;
  key_name TEXT;
  v TEXT;
BEGIN
  IF p_row IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value INTO cfg FROM system_settings WHERE key = 'bom_scanner' LIMIT 1;
  IF cfg IS NULL THEN
    RETURN NULL;
  END IF;

  FOR key_name IN
    SELECT jsonb_array_elements_text(COALESCE(cfg->'jsonKeyMap'->'downloadUrl', '[]'::jsonb))
  LOOP
    v := NULLIF(BTRIM(p_row ->> key_name), '');
    IF v IS NOT NULL THEN
      RETURN v;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;


--
-- Name: FUNCTION bom_extract_download_url(p_row jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_extract_download_url(p_row jsonb) IS '按 bom_scanner.jsonKeyMap.downloadUrl 从 BOM 行提取下载路径/URL';


--
-- Name: bom_extract_expected_md5(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_extract_expected_md5(p_row jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  cfg JSONB;
  key_name TEXT;
  v TEXT;
BEGIN
  IF p_row IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value INTO cfg FROM system_settings WHERE key = 'bom_scanner' LIMIT 1;
  IF cfg IS NULL THEN
    RETURN NULL;
  END IF;

  FOR key_name IN
    SELECT jsonb_array_elements_text(COALESCE(cfg->'jsonKeyMap'->'expectedMd5', '[]'::jsonb))
  LOOP
    v := NULLIF(BTRIM(p_row ->> key_name), '');
    IF v IS NOT NULL THEN
      RETURN LOWER(v);
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;


--
-- Name: FUNCTION bom_extract_expected_md5(p_row jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_extract_expected_md5(p_row jsonb) IS '按 bom_scanner.jsonKeyMap.expectedMd5 从 BOM 行提取期望 MD5';


--
-- Name: bom_extract_ext_url(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_extract_ext_url(p_row jsonb) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  cfg JSONB;
  key_name TEXT;
  v TEXT;
BEGIN
  IF p_row IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT value INTO cfg FROM system_settings WHERE key = 'bom_scanner' LIMIT 1;
  IF cfg IS NULL THEN
    RETURN NULL;
  END IF;

  FOR key_name IN
    SELECT jsonb_array_elements_text(COALESCE(cfg->'jsonKeyMap'->'extUrl', '["ext_url","extUrl","转存地址"]'::jsonb))
  LOOP
    v := NULLIF(BTRIM(p_row ->> key_name), '');
    IF v IS NOT NULL THEN
      RETURN v;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;


--
-- Name: FUNCTION bom_extract_ext_url(p_row jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_extract_ext_url(p_row jsonb) IS '按 bom_scanner.jsonKeyMap.extUrl 从 BOM 行提取 ext 转存 URI';


--
-- Name: bom_fail_stale_download_jobs(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_fail_stale_download_jobs(p_stale_seconds integer DEFAULT 900) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  n INTEGER := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 60 THEN
    p_stale_seconds := 900;
  END IF;
  v_cutoff := NOW() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE bom_download_jobs j
  SET status = 'failed'::bom_download_job_status,
      finished_at = NOW(),
      last_message = 'worker 心跳超时（可能进程崩溃或网络中断）',
      updated_at = NOW(),
      running_row_id = NULL,
      running_file_name = NULL
  WHERE j.status = 'running'::bom_download_job_status
    AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;


--
-- Name: FUNCTION bom_fail_stale_download_jobs(p_stale_seconds integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_fail_stale_download_jobs(p_stale_seconds integer) IS '将 running 且心跳过期的下载任务标记为 failed（service_role）';


--
-- Name: bom_fail_stale_ext_sync_jobs(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_fail_stale_ext_sync_jobs(p_stale_seconds integer DEFAULT 900) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  n INTEGER := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 60 THEN
    p_stale_seconds := 900;
  END IF;
  v_cutoff := NOW() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE bom_ext_sync_jobs j
  SET status = 'failed'::bom_download_job_status,
      finished_at = NOW(),
      last_message = 'worker 心跳超时（可能进程崩溃或网络中断）',
      updated_at = NOW(),
      running_row_id = NULL
  WHERE j.status = 'running'::bom_download_job_status
    AND COALESCE(j.heartbeat_at, j.updated_at, j.started_at) < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;


--
-- Name: bom_fail_stale_scan_jobs(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_fail_stale_scan_jobs(p_stale_seconds integer DEFAULT 7200) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  n INTEGER := 0;
  v_cutoff TIMESTAMPTZ;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 300 THEN
    p_stale_seconds := 7200;
  END IF;
  v_cutoff := NOW() - (p_stale_seconds::text || ' seconds')::interval;

  UPDATE bom_scan_jobs j
  SET status = 'failed'::bom_scan_job_status,
      finished_at = NOW(),
      message = '扫描任务超时未结束（worker 可能崩溃或进程被中断）；未执行 bom_finalize_scan，local_file 未 prune。下次成功扫描后会收敛。',
      updated_at = NOW()
  WHERE j.status = 'running'::bom_scan_job_status
    AND j.started_at IS NOT NULL
    AND j.started_at < v_cutoff;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;


--
-- Name: FUNCTION bom_fail_stale_scan_jobs(p_stale_seconds integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_fail_stale_scan_jobs(p_stale_seconds integer) IS '将 running 且 started_at 过久未结束的扫描任务标记为 failed（service_role），解除调度阻塞';


--
-- Name: bom_file_basename(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_file_basename(p_path text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF p_path IS NULL OR BTRIM(p_path) = '' THEN
    RETURN NULL;
  END IF;
  RETURN LOWER(regexp_replace(BTRIM(p_path), '^.*/', ''));
END;
$$;


--
-- Name: FUNCTION bom_file_basename(p_path text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_file_basename(p_path text) IS '取路径最后一段（小写），用于与下载 URL 的文件名片段比对';


--
-- Name: bom_finalize_scan(uuid, boolean, integer, integer, integer, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_finalize_scan(p_job_id uuid, p_success boolean DEFAULT true, p_files_seen integer DEFAULT 0, p_files_md5_updated integer DEFAULT 0, p_files_removed integer DEFAULT 0, p_message text DEFAULT NULL::text, p_prune_missing boolean DEFAULT true) RETURNS TABLE(removed_count integer, status_updates integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  removed_n INTEGER := 0;
  status_n INTEGER := 0;
BEGIN
  IF p_prune_missing THEN
    DELETE FROM local_file
    WHERE last_seen_scan_job_id IS NOT NULL
      AND last_seen_scan_job_id IS DISTINCT FROM p_job_id;
    GET DIAGNOSTICS removed_n = ROW_COUNT;
  END IF;

  SELECT bom_refresh_local_found_statuses() INTO status_n;

  UPDATE bom_scan_jobs
  SET status = CASE WHEN p_success THEN 'succeeded'::bom_scan_job_status ELSE 'failed'::bom_scan_job_status END,
      finished_at = NOW(),
      files_seen = COALESCE(p_files_seen, 0),
      files_md5_updated = COALESCE(p_files_md5_updated, 0),
      files_removed = COALESCE(p_files_removed, 0) + removed_n,
      message = p_message
  WHERE id = p_job_id;

  removed_count := removed_n;
  status_updates := status_n;
  RETURN NEXT;
END;
$$;


--
-- Name: FUNCTION bom_finalize_scan(p_job_id uuid, p_success boolean, p_files_seen integer, p_files_md5_updated integer, p_files_removed integer, p_message text, p_prune_missing boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_finalize_scan(p_job_id uuid, p_success boolean, p_files_seen integer, p_files_md5_updated integer, p_files_removed integer, p_message text, p_prune_missing boolean) IS '结束扫描：prune 仅针对曾挂过 scan_job 的索引行；last_seen_scan_job_id 为 NULL 的（网页下载直写）保留至磁盘 walk 覆盖';


--
-- Name: bom_mark_scan_started(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_mark_scan_started(p_job_id uuid, p_message text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  UPDATE bom_scan_jobs
  SET status = 'running',
      started_at = NOW(),
      message = p_message
  WHERE id = p_job_id;

  RETURN FOUND;
END;
$$;


--
-- Name: bom_refresh_local_found_statuses(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_refresh_local_found_statuses() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  n INTEGER := 0;
BEGIN
  UPDATE bom_rows br
  SET
    status = jsonb_set(
      CASE
        WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download')
        THEN br.status - 'local_fetch_error'
        ELSE br.status
      END,
      '{local}',
      to_jsonb(
        CASE
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      ),
      true
    )
  FROM (
    SELECT
      br2.id,
      CASE
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
             )
          THEN 'verified_ok'
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) <> bom_extract_expected_md5(br2.bom_row)
                 AND bom_file_basename(lf.path) IS NOT NULL
                 AND bom_url_path_basename(bom_extract_download_url(br2.bom_row)) IS NOT NULL
                 AND bom_file_basename(lf.path) = bom_url_path_basename(bom_extract_download_url(br2.bom_row))
             )
          THEN 'verified_fail'
        WHEN NULLIF(BTRIM(COALESCE(bom_extract_download_url(br2.bom_row), '')), '') IS NOT NULL
             AND NOT bom_url_looks_like_it_artifactory(bom_extract_download_url(br2.bom_row))
             AND NOT (
               bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
               AND EXISTS (
                 SELECT 1
                 FROM local_file lf
                 WHERE lf.md5 IS NOT NULL
                   AND lf.md5 ~ '^[a-f0-9]{32}$'
                   AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
               )
             )
          THEN 'await_manual_download'
        ELSE 'pending'
      END AS new_local
    FROM bom_rows br2
  ) sub
  WHERE br.id = sub.id
    AND (br.status->>'ext') IS DISTINCT FROM 'synced_or_skipped'
    AND (
      (br.status->>'local') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      )
      OR NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '')
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$_$;


--
-- Name: FUNCTION bom_refresh_local_found_statuses(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_refresh_local_found_statuses() IS '扫描结束后仅更新 status.local；不修改 ext=synced_or_skipped；local_fetch_error 在本地终态时清除';


--
-- Name: bom_refresh_local_found_statuses_for_batch(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_refresh_local_found_statuses_for_batch(p_batch_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  n INTEGER := 0;
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bom_batches b WHERE b.id = p_batch_id AND b.user_id = v_user) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE bom_rows br
  SET
    status = jsonb_set(
      CASE
        WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download')
        THEN br.status - 'local_fetch_error'
        ELSE br.status
      END,
      '{local}',
      to_jsonb(
        CASE
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      ),
      true
    )
  FROM (
    SELECT
      br2.id,
      CASE
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
             )
          THEN 'verified_ok'
        WHEN bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
             AND EXISTS (
               SELECT 1
               FROM local_file lf
               WHERE lf.md5 IS NOT NULL
                 AND lf.md5 ~ '^[a-f0-9]{32}$'
                 AND LOWER(lf.md5) <> bom_extract_expected_md5(br2.bom_row)
                 AND bom_file_basename(lf.path) IS NOT NULL
                 AND bom_url_path_basename(bom_extract_download_url(br2.bom_row)) IS NOT NULL
                 AND bom_file_basename(lf.path) = bom_url_path_basename(bom_extract_download_url(br2.bom_row))
             )
          THEN 'verified_fail'
        WHEN NULLIF(BTRIM(COALESCE(bom_extract_download_url(br2.bom_row), '')), '') IS NOT NULL
             AND NOT bom_url_looks_like_it_artifactory(bom_extract_download_url(br2.bom_row))
             AND NOT (
               bom_extract_expected_md5(br2.bom_row) ~ '^[a-f0-9]{32}$'
               AND EXISTS (
                 SELECT 1
                 FROM local_file lf
                 WHERE lf.md5 IS NOT NULL
                   AND lf.md5 ~ '^[a-f0-9]{32}$'
                   AND LOWER(lf.md5) = bom_extract_expected_md5(br2.bom_row)
               )
             )
          THEN 'await_manual_download'
        ELSE 'pending'
      END AS new_local
    FROM bom_rows br2
    WHERE br2.batch_id = p_batch_id
  ) sub
  WHERE br.id = sub.id
    AND br.batch_id = p_batch_id
    AND (br.status->>'ext') IS DISTINCT FROM 'synced_or_skipped'
    AND (
      (br.status->>'local') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local = 'pending'
               AND NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS NOT NULL
            THEN 'error'
          ELSE sub.new_local
        END
      )
      OR NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '') IS DISTINCT FROM (
        CASE
          WHEN sub.new_local IN ('verified_ok', 'verified_fail', 'await_manual_download') THEN NULL::text
          ELSE NULLIF(BTRIM(COALESCE(br.status->>'local_fetch_error', '')), '')
        END
      )
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$_$;


--
-- Name: FUNCTION bom_refresh_local_found_statuses_for_batch(p_batch_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_refresh_local_found_statuses_for_batch(p_batch_id uuid) IS '按 local_file 重算该批次 status.local（跳过 ext=synced_or_skipped）；local_fetch_error 在本地终态时清除';


--
-- Name: bom_request_download(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[] DEFAULT NULL::uuid[]) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_user UUID := auth.uid();
  v_job UUID;
  v_ids UUID[];
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bom_batches b WHERE b.id = p_batch_id AND b.user_id = v_user) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
        AND bom_extract_download_url(br.bom_row) ~ '^https?://'
        AND (
          bom_extract_expected_md5(br.bom_row) IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM local_file lf
            WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
              AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
          )
        )
        AND (
          (br.status->>'local') IN ('pending', 'error')
          OR (
            (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
            AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
          )
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
      AND bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM local_file lf
          WHERE lf.md5 IS NOT NULL AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
        )
      )
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  INSERT INTO bom_download_jobs (batch_id, user_id, row_ids, status, progress_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$_$;


--
-- Name: FUNCTION bom_request_download(p_batch_id uuid, p_row_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[]) IS '网页触发 it 拉取：p_row_ids 为空则当前批次全部 eligible 行';


--
-- Name: bom_request_ext_sync(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[] DEFAULT NULL::uuid[]) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user UUID := auth.uid();
  v_job UUID;
  v_ids UUID[];
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bom_batches b WHERE b.id = p_batch_id AND b.user_id = v_user) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_row_ids IS NOT NULL AND cardinality(p_row_ids) > 0 THEN
    SELECT COALESCE(array_agg(s.id ORDER BY s.ord), ARRAY[]::uuid[])
    INTO v_ids
    FROM (
      SELECT br.id, k.ord
      FROM unnest(p_row_ids) WITH ORDINALITY AS k(rid, ord)
      JOIN bom_rows br ON br.id = k.rid AND br.batch_id = p_batch_id
      WHERE (br.status->>'local') = 'verified_ok'
        AND (
          bom_extract_ext_url(br.bom_row) IS NULL
          OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
        )
    ) s;
  ELSE
    SELECT COALESCE(array_agg(br.id ORDER BY br.created_at), ARRAY[]::uuid[])
    INTO v_ids
    FROM bom_rows br
    WHERE br.batch_id = p_batch_id
      AND (br.status->>'local') = 'verified_ok'
      AND (
        bom_extract_ext_url(br.bom_row) IS NULL
        OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
      );
  END IF;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no eligible rows';
  END IF;

  INSERT INTO bom_ext_sync_jobs (batch_id, user_id, row_ids, status, progress_total, trigger_source)
  VALUES (p_batch_id, v_user, v_ids, 'queued', cardinality(v_ids), 'web')
  RETURNING id INTO v_job;

  RETURN v_job;
END;
$$;


--
-- Name: FUNCTION bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]) IS '网页触发 ext 同步：p_row_ids 为空则当前批次全部「校验通过且尚无 ext_url」行';


--
-- Name: bom_request_scan(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_request_scan(p_trigger_source text DEFAULT 'manual'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO bom_scan_jobs (status, trigger_source, requested_at)
  VALUES ('queued', COALESCE(NULLIF(BTRIM(p_trigger_source), ''), 'manual'), NOW())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


--
-- Name: bom_row_download_targets(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_row_download_targets(p_ids uuid[]) RETURNS TABLE(id uuid, download_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT br.id, bom_extract_download_url(br.bom_row) AS download_url
  FROM bom_rows br
  WHERE br.id = ANY(p_ids);
$$;


--
-- Name: bom_row_still_eligible_for_ext_sync(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_row_still_eligible_for_ext_sync(p_row_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bom_rows br
    WHERE br.id = p_row_id
      AND (br.status->>'local') = 'verified_ok'
      AND (
        bom_extract_ext_url(br.bom_row) IS NULL
        OR BTRIM(bom_extract_ext_url(br.bom_row)) = ''
      )
  );
$$;


--
-- Name: bom_row_still_eligible_for_it_download(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_row_still_eligible_for_it_download(p_row_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  SELECT EXISTS (
    SELECT 1
    FROM bom_rows br
    WHERE br.id = p_row_id
      AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
      AND bom_extract_download_url(br.bom_row) ~ '^https?://'
      AND (
        bom_extract_expected_md5(br.bom_row) IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM local_file lf
          WHERE lf.md5 IS NOT NULL
            AND lf.md5 ~ '^[a-f0-9]{32}$'
            AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
        )
      )
      AND (
        (br.status->>'local') IN ('pending', 'error')
        OR (
          (br.status->>'local') IN ('verified_ok', 'verified_fail', 'local_found')
          AND bom_extract_expected_md5(br.bom_row) ~ '^[a-f0-9]{32}$'
        )
      )
  );
$_$;


--
-- Name: FUNCTION bom_row_still_eligible_for_it_download(p_row_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_row_still_eligible_for_it_download(p_row_id uuid) IS 'it 拉取：pending/error；或 verified_ok|verified_fail|local_found 且期望 MD5 在 local_file 中不存在时可再拉';


--
-- Name: bom_rows_for_it_download(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_rows_for_it_download(p_limit integer DEFAULT 25) RETURNS TABLE(id uuid, download_url text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  SELECT br.id,
         bom_extract_download_url(br.bom_row) AS download_url
  FROM bom_rows br
  WHERE (br.status->>'local') IN ('pending', 'error')
    AND bom_url_looks_like_it_artifactory(bom_extract_download_url(br.bom_row))
    AND bom_extract_download_url(br.bom_row) ~ '^https?://'
    AND (
      bom_extract_expected_md5(br.bom_row) IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM local_file lf
        WHERE lf.md5 IS NOT NULL
          AND lf.md5 ~ '^[a-f0-9]{32}$'
          AND LOWER(lf.md5) = bom_extract_expected_md5(br.bom_row)
      )
    )
  ORDER BY br.updated_at ASC NULLS FIRST, br.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100));
$_$;


--
-- Name: FUNCTION bom_rows_for_it_download(p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_rows_for_it_download(p_limit integer) IS '阶段 4：返回待由 worker 从内部 Artifactory 拉取的 BOM 行（service_role）';


--
-- Name: bom_sync_bom_row_local_size_from_index(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_sync_bom_row_local_size_from_index() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  jm jsonb;
  keys text[];
  k text;
  n INTEGER := 0;
  br_rec RECORD;
  md5l TEXT;
  sz BIGINT;
  next_bom jsonb;
BEGIN
  SELECT COALESCE(value->'jsonKeyMap', '{}'::jsonb) INTO jm
  FROM system_settings
  WHERE key = 'bom_scanner'
  LIMIT 1;

  SELECT COALESCE(array_agg(e ORDER BY ord), ARRAY['文件大小'::text])
  INTO keys
  FROM jsonb_array_elements_text(COALESCE(jm->'fileSizeBytes', '["文件大小"]'::jsonb)) WITH ORDINALITY AS t(e, ord);

  IF keys IS NULL OR cardinality(keys) = 0 THEN
    keys := ARRAY['文件大小'];
  END IF;

  FOR br_rec IN
    SELECT id, bom_row
    FROM bom_rows
    WHERE bom_extract_expected_md5(bom_row) ~ '^[a-f0-9]{32}$'
  LOOP
    md5l := lower(bom_extract_expected_md5(br_rec.bom_row));
    SELECT lf.size_bytes INTO sz
    FROM local_file lf
    WHERE lf.md5 IS NOT NULL
      AND lower(lf.md5) = md5l
    ORDER BY lf.updated_at DESC NULLS LAST
    LIMIT 1;

    IF sz IS NULL THEN
      CONTINUE;
    END IF;

    next_bom := br_rec.bom_row;
    FOREACH k IN ARRAY keys LOOP
      IF k IS NULL OR BTRIM(k) = '' THEN
        CONTINUE;
      END IF;
      next_bom := jsonb_set(next_bom, ARRAY[k], to_jsonb(sz::text), true);
    END LOOP;

    IF next_bom IS DISTINCT FROM br_rec.bom_row THEN
      UPDATE bom_rows SET bom_row = next_bom WHERE id = br_rec.id;
      n := n + 1;
    END IF;
  END LOOP;

  RETURN n;
END;
$_$;


--
-- Name: FUNCTION bom_sync_bom_row_local_size_from_index(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_sync_bom_row_local_size_from_index() IS '按期望 MD5 关联 local_file.size_bytes，写回 bom_row 中 jsonKeyMap.fileSizeBytes 所列列名';


--
-- Name: bom_upsert_local_file(uuid, text, bigint, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_upsert_local_file(p_job_id uuid, p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
BEGIN
  IF p_path IS NULL OR BTRIM(p_path) = '' THEN
    RAISE EXCEPTION 'p_path cannot be empty';
  END IF;

  INSERT INTO local_file (path, size_bytes, mtime, md5, last_seen_scan_job_id, last_seen_at)
  VALUES (
    BTRIM(p_path),
    COALESCE(p_size_bytes, 0),
    p_mtime,
    CASE
      WHEN p_md5 ~* '^[a-f0-9]{32}$' THEN LOWER(p_md5)
      ELSE NULL
    END,
    p_job_id,
    NOW()
  )
  ON CONFLICT (path) DO UPDATE
  SET size_bytes = EXCLUDED.size_bytes,
      mtime = EXCLUDED.mtime,
      md5 = CASE
        WHEN EXCLUDED.md5 IS NOT NULL THEN EXCLUDED.md5
        ELSE local_file.md5
      END,
      last_seen_scan_job_id = EXCLUDED.last_seen_scan_job_id,
      last_seen_at = EXCLUDED.last_seen_at;

  RETURN true;
END;
$_$;


--
-- Name: bom_upsert_local_file_web(text, bigint, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_upsert_local_file_web(p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
BEGIN
  IF p_path IS NULL OR BTRIM(p_path) = '' THEN
    RAISE EXCEPTION 'p_path cannot be empty';
  END IF;

  INSERT INTO local_file (path, size_bytes, mtime, md5, last_seen_scan_job_id, last_seen_at)
  VALUES (
    BTRIM(p_path),
    COALESCE(p_size_bytes, 0),
    p_mtime,
    CASE
      WHEN p_md5 ~* '^[a-f0-9]{32}$' THEN LOWER(p_md5)
      ELSE NULL
    END,
    NULL,
    NOW()
  )
  ON CONFLICT (path) DO UPDATE
  SET size_bytes = EXCLUDED.size_bytes,
      mtime = EXCLUDED.mtime,
      md5 = CASE
        WHEN EXCLUDED.md5 IS NOT NULL THEN EXCLUDED.md5
        ELSE local_file.md5
      END,
      last_seen_at = EXCLUDED.last_seen_at;

  RETURN true;
END;
$_$;


--
-- Name: bom_url_looks_like_it_artifactory(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_url_looks_like_it_artifactory(p text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  IF p IS NULL OR BTRIM(p) = '' THEN
    RETURN false;
  END IF;
  RETURN BTRIM(p) ~* 'artifactory';
END;
$$;


--
-- Name: FUNCTION bom_url_looks_like_it_artifactory(p text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_url_looks_like_it_artifactory(p text) IS '粗判是否为内部 Artifactory 类链接（阶段 4 自动下载）；其它来源走待人工下载';


--
-- Name: bom_url_path_basename(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bom_url_path_basename(p text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  t TEXT;
BEGIN
  IF p IS NULL OR BTRIM(p) = '' THEN
    RETURN NULL;
  END IF;
  t := BTRIM(p);
  t := regexp_replace(t, '^[a-z][a-z0-9+.-]*://[^/]+', '', 'i');
  t := regexp_replace(t, '\\?.*$', '');
  t := regexp_replace(t, '.*/', '');
  RETURN NULLIF(LOWER(t), '');
END;
$_$;


--
-- Name: FUNCTION bom_url_path_basename(p text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bom_url_path_basename(p text) IS '从下载路径/URL 提取文件名（小写），去掉协议、主机与查询串';


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION update_updated_at_column(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_updated_at_column() IS '自动更新 updated_at 字段';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bom_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    product_id uuid NOT NULL,
    header_order jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: TABLE bom_batches; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bom_batches IS 'BOM 批次/名称';


--
-- Name: COLUMN bom_batches.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_batches.name IS '批次显示名或清单名';


--
-- Name: COLUMN bom_batches.header_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_batches.header_order IS '导入时的表头顺序（字符串数组），用于明细页按导入顺序展示列';


--
-- Name: bom_download_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_download_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    user_id uuid NOT NULL,
    row_ids uuid[] NOT NULL,
    status public.bom_download_job_status DEFAULT 'queued'::public.bom_download_job_status NOT NULL,
    progress_current integer DEFAULT 0 NOT NULL,
    progress_total integer DEFAULT 0 NOT NULL,
    last_message text,
    trigger_source text DEFAULT 'web'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    running_row_id uuid,
    running_file_name text,
    running_bytes_downloaded bigint DEFAULT 0 NOT NULL,
    running_bytes_total bigint,
    bytes_downloaded_total bigint DEFAULT 0 NOT NULL,
    bytes_total bigint,
    cancel_requested boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE bom_download_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bom_download_jobs IS '网页或后台触发的内部 Artifactory 批量拉取任务（worker 消费）';


--
-- Name: COLUMN bom_download_jobs.started_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.started_at IS 'worker 首次抢占为 running 的时间';


--
-- Name: COLUMN bom_download_jobs.heartbeat_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.heartbeat_at IS 'worker 心跳，用于僵尸任务回收';


--
-- Name: COLUMN bom_download_jobs.running_row_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.running_row_id IS '当前正在下载的 BOM 行';


--
-- Name: COLUMN bom_download_jobs.running_file_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.running_file_name IS '当前下载目标文件名（展示）';


--
-- Name: COLUMN bom_download_jobs.running_bytes_downloaded; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.running_bytes_downloaded IS '当前文件已下载字节';


--
-- Name: COLUMN bom_download_jobs.running_bytes_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.running_bytes_total IS '当前文件总字节（Content-Length 等，可为空）';


--
-- Name: COLUMN bom_download_jobs.bytes_downloaded_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.bytes_downloaded_total IS '本任务已完成的文件字节累计';


--
-- Name: COLUMN bom_download_jobs.bytes_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.bytes_total IS '本任务预估总字节（能汇总时写入，可为空）';


--
-- Name: COLUMN bom_download_jobs.cancel_requested; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_download_jobs.cancel_requested IS '用户请求取消 running 任务时置 true，worker 检测后置 cancelled 并清零';


--
-- Name: bom_ext_sync_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_ext_sync_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    user_id uuid NOT NULL,
    row_ids uuid[] NOT NULL,
    status public.bom_download_job_status DEFAULT 'queued'::public.bom_download_job_status NOT NULL,
    progress_current integer DEFAULT 0 NOT NULL,
    progress_total integer DEFAULT 0 NOT NULL,
    last_message text,
    trigger_source text DEFAULT 'web'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    running_row_id uuid,
    cancel_requested boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE bom_ext_sync_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bom_ext_sync_jobs IS '网页触发的外部 Artifactory 同步任务（worker 消费）：校验通过后 checksum 查重、Copy 或上传';


--
-- Name: COLUMN bom_ext_sync_jobs.cancel_requested; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_ext_sync_jobs.cancel_requested IS '用户请求取消 running 任务时置 true，worker 检测后置 cancelled 并清零';


--
-- Name: bom_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    bom_row jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    status jsonb DEFAULT '{"ext": "not_started", "local": "pending"}'::jsonb NOT NULL,
    CONSTRAINT bom_rows_status_keys CHECK (((status ? 'local'::text) AND (status ? 'ext'::text) AND ((status ->> 'local'::text) = ANY (ARRAY['pending'::text, 'await_manual_download'::text, 'local_found'::text, 'verified_ok'::text, 'verified_fail'::text, 'error'::text])) AND ((status ->> 'ext'::text) = ANY (ARRAY['not_started'::text, 'synced_or_skipped'::text, 'error'::text]))))
);


--
-- Name: TABLE bom_rows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bom_rows IS 'BOM 行：bom_row 为唯一事实来源';


--
-- Name: COLUMN bom_rows.bom_row; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_rows.bom_row IS '整行原始结构（列名可变，解析层按配置 key 映射）';


--
-- Name: COLUMN bom_rows.sort_order; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_rows.sort_order IS '批次内行序（0 起），与入库时数组下标一致';


--
-- Name: COLUMN bom_rows.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_rows.status IS 'JSONB：local、ext 为枚举状态；可选 local_fetch_error / ext_fetch_error 为 it 与 ext 链路说明文本';


--
-- Name: bom_scan_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_scan_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status public.bom_scan_job_status DEFAULT 'queued'::public.bom_scan_job_status NOT NULL,
    trigger_source text DEFAULT 'manual'::text NOT NULL,
    message text,
    files_seen integer DEFAULT 0 NOT NULL,
    files_md5_updated integer DEFAULT 0 NOT NULL,
    files_removed integer DEFAULT 0 NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE bom_scan_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bom_scan_jobs IS '本地目录扫描任务（可手动触发或定时触发）';


--
-- Name: COLUMN bom_scan_jobs.trigger_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bom_scan_jobs.trigger_source IS '触发来源，如 manual/scheduler/worker';


--
-- Name: local_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_file (
    path text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    mtime timestamp with time zone,
    md5 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_scan_job_id uuid,
    last_seen_at timestamp with time zone
);


--
-- Name: TABLE local_file; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.local_file IS '本地暂存目录扫描索引';


--
-- Name: COLUMN local_file.path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_file.path IS '相对根目录或绝对路径（整站固定一种）';


--
-- Name: COLUMN local_file.md5; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_file.md5 IS '内容 MD5，未算出前可为空';


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE products; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.products IS '产品（用户维度）';


--
-- Name: COLUMN products.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.products.name IS '产品名称';


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE system_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.system_settings IS '系统设置表（全局配置，无用户维度）';


--
-- Name: bom_batches bom_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_batches
    ADD CONSTRAINT bom_batches_pkey PRIMARY KEY (id);


--
-- Name: bom_download_jobs bom_download_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_download_jobs
    ADD CONSTRAINT bom_download_jobs_pkey PRIMARY KEY (id);


--
-- Name: bom_ext_sync_jobs bom_ext_sync_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_ext_sync_jobs
    ADD CONSTRAINT bom_ext_sync_jobs_pkey PRIMARY KEY (id);


--
-- Name: bom_rows bom_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_rows
    ADD CONSTRAINT bom_rows_pkey PRIMARY KEY (id);


--
-- Name: bom_scan_jobs bom_scan_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_scan_jobs
    ADD CONSTRAINT bom_scan_jobs_pkey PRIMARY KEY (id);


--
-- Name: local_file local_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_file
    ADD CONSTRAINT local_file_pkey PRIMARY KEY (path);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_user_id_name_key UNIQUE (user_id, name);


--
-- Name: system_settings system_settings_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_key_key UNIQUE (key);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);


--
-- Name: idx_bom_batches_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_batches_created ON public.bom_batches USING btree (created_at DESC);


--
-- Name: idx_bom_batches_product; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_batches_product ON public.bom_batches USING btree (product_id);


--
-- Name: idx_bom_batches_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_batches_user ON public.bom_batches USING btree (user_id);


--
-- Name: idx_bom_download_jobs_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_download_jobs_batch ON public.bom_download_jobs USING btree (batch_id, created_at DESC);


--
-- Name: idx_bom_download_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_download_jobs_status ON public.bom_download_jobs USING btree (status);


--
-- Name: idx_bom_ext_sync_jobs_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_ext_sync_jobs_batch ON public.bom_ext_sync_jobs USING btree (batch_id, created_at DESC);


--
-- Name: idx_bom_ext_sync_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_ext_sync_jobs_status ON public.bom_ext_sync_jobs USING btree (status);


--
-- Name: idx_bom_rows_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_rows_batch ON public.bom_rows USING btree (batch_id);


--
-- Name: idx_bom_rows_batch_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_rows_batch_sort ON public.bom_rows USING btree (batch_id, sort_order);


--
-- Name: idx_bom_rows_status_ext; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_rows_status_ext ON public.bom_rows USING btree (((status ->> 'ext'::text)));


--
-- Name: idx_bom_rows_status_local; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_rows_status_local ON public.bom_rows USING btree (((status ->> 'local'::text)));


--
-- Name: idx_bom_scan_jobs_requested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_scan_jobs_requested_at ON public.bom_scan_jobs USING btree (requested_at DESC);


--
-- Name: idx_bom_scan_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bom_scan_jobs_status ON public.bom_scan_jobs USING btree (status);


--
-- Name: idx_local_file_last_seen_scan_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_file_last_seen_scan_job ON public.local_file USING btree (last_seen_scan_job_id);


--
-- Name: idx_local_file_md5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_file_md5 ON public.local_file USING btree (md5) WHERE (md5 IS NOT NULL);


--
-- Name: idx_products_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_user ON public.products USING btree (user_id);


--
-- Name: idx_system_settings_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_settings_key ON public.system_settings USING btree (key);


--
-- Name: bom_batches trg_bom_batches_product_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bom_batches_product_owner BEFORE INSERT OR UPDATE OF product_id, user_id ON public.bom_batches FOR EACH ROW EXECUTE FUNCTION public.bom_batch_product_must_belong_to_user();


--
-- Name: bom_batches update_bom_batches_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bom_batches_updated_at BEFORE UPDATE ON public.bom_batches FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bom_download_jobs update_bom_download_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bom_download_jobs_updated_at BEFORE UPDATE ON public.bom_download_jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bom_ext_sync_jobs update_bom_ext_sync_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bom_ext_sync_jobs_updated_at BEFORE UPDATE ON public.bom_ext_sync_jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bom_rows update_bom_rows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bom_rows_updated_at BEFORE UPDATE ON public.bom_rows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bom_scan_jobs update_bom_scan_jobs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bom_scan_jobs_updated_at BEFORE UPDATE ON public.bom_scan_jobs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: local_file update_local_file_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_local_file_updated_at BEFORE UPDATE ON public.local_file FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: products update_products_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: system_settings update_system_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_system_settings_updated_at BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bom_batches bom_batches_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_batches
    ADD CONSTRAINT bom_batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;


--
-- Name: bom_batches bom_batches_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_batches
    ADD CONSTRAINT bom_batches_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bom_download_jobs bom_download_jobs_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_download_jobs
    ADD CONSTRAINT bom_download_jobs_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.bom_batches(id) ON DELETE CASCADE;


--
-- Name: bom_download_jobs bom_download_jobs_running_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_download_jobs
    ADD CONSTRAINT bom_download_jobs_running_row_id_fkey FOREIGN KEY (running_row_id) REFERENCES public.bom_rows(id) ON DELETE SET NULL;


--
-- Name: bom_download_jobs bom_download_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_download_jobs
    ADD CONSTRAINT bom_download_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bom_ext_sync_jobs bom_ext_sync_jobs_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_ext_sync_jobs
    ADD CONSTRAINT bom_ext_sync_jobs_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.bom_batches(id) ON DELETE CASCADE;


--
-- Name: bom_ext_sync_jobs bom_ext_sync_jobs_running_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_ext_sync_jobs
    ADD CONSTRAINT bom_ext_sync_jobs_running_row_id_fkey FOREIGN KEY (running_row_id) REFERENCES public.bom_rows(id) ON DELETE SET NULL;


--
-- Name: bom_ext_sync_jobs bom_ext_sync_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_ext_sync_jobs
    ADD CONSTRAINT bom_ext_sync_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bom_rows bom_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_rows
    ADD CONSTRAINT bom_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.bom_batches(id) ON DELETE CASCADE;


--
-- Name: local_file local_file_last_seen_scan_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_file
    ADD CONSTRAINT local_file_last_seen_scan_job_id_fkey FOREIGN KEY (last_seen_scan_job_id) REFERENCES public.bom_scan_jobs(id) ON DELETE SET NULL;


--
-- Name: products products_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: local_file Authenticated can delete local_file; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can delete local_file" ON public.local_file FOR DELETE USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: system_settings Authenticated can delete settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can delete settings" ON public.system_settings FOR DELETE USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: bom_scan_jobs Authenticated can insert bom_scan_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can insert bom_scan_jobs" ON public.bom_scan_jobs FOR INSERT WITH CHECK ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: local_file Authenticated can insert local_file; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can insert local_file" ON public.local_file FOR INSERT WITH CHECK ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: bom_scan_jobs Authenticated can read bom_scan_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read bom_scan_jobs" ON public.bom_scan_jobs FOR SELECT USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: local_file Authenticated can read local_file; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read local_file" ON public.local_file FOR SELECT USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: system_settings Authenticated can read settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read settings" ON public.system_settings FOR SELECT USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: local_file Authenticated can update local_file; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can update local_file" ON public.local_file FOR UPDATE USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: system_settings Authenticated can update settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can update settings" ON public.system_settings FOR UPDATE USING ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: system_settings Authenticated can write settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can write settings" ON public.system_settings FOR INSERT WITH CHECK ((auth.role() = ANY (ARRAY['authenticated'::text, 'service_role'::text])));


--
-- Name: bom_batches Service role full bom batches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full bom batches" ON public.bom_batches TO service_role USING (true) WITH CHECK (true);


--
-- Name: bom_rows Service role full bom rows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full bom rows" ON public.bom_rows TO service_role USING (true) WITH CHECK (true);


--
-- Name: bom_download_jobs Service role full bom_download_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full bom_download_jobs" ON public.bom_download_jobs TO service_role USING (true) WITH CHECK (true);


--
-- Name: bom_ext_sync_jobs Service role full bom_ext_sync_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full bom_ext_sync_jobs" ON public.bom_ext_sync_jobs TO service_role USING (true) WITH CHECK (true);


--
-- Name: bom_scan_jobs Service role full bom_scan_jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full bom_scan_jobs" ON public.bom_scan_jobs TO service_role USING (true) WITH CHECK (true);


--
-- Name: products Service role full products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full products" ON public.products TO service_role USING (true) WITH CHECK (true);


--
-- Name: bom_rows Users manage bom rows via own batch; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage bom rows via own batch" ON public.bom_rows USING ((EXISTS ( SELECT 1
   FROM public.bom_batches b
  WHERE ((b.id = bom_rows.batch_id) AND (b.user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.bom_batches b
  WHERE ((b.id = bom_rows.batch_id) AND (b.user_id = auth.uid())))));


--
-- Name: bom_batches Users manage own bom batches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own bom batches" ON public.bom_batches USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: products Users manage own products; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own products" ON public.products USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: bom_download_jobs Users read own batch download jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read own batch download jobs" ON public.bom_download_jobs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.bom_batches b
  WHERE ((b.id = bom_download_jobs.batch_id) AND (b.user_id = auth.uid())))));


--
-- Name: bom_ext_sync_jobs Users read own batch ext sync jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read own batch ext sync jobs" ON public.bom_ext_sync_jobs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.bom_batches b
  WHERE ((b.id = bom_ext_sync_jobs.batch_id) AND (b.user_id = auth.uid())))));


--
-- Name: bom_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: bom_download_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_download_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: bom_ext_sync_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_ext_sync_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: bom_rows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_rows ENABLE ROW LEVEL SECURITY;

--
-- Name: bom_scan_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_scan_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: local_file; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_file ENABLE ROW LEVEL SECURITY;

--
-- Name: products; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION bom_batch_product_must_belong_to_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_batch_product_must_belong_to_user() TO anon;
GRANT ALL ON FUNCTION public.bom_batch_product_must_belong_to_user() TO authenticated;
GRANT ALL ON FUNCTION public.bom_batch_product_must_belong_to_user() TO service_role;


--
-- Name: FUNCTION bom_cancel_download_job(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_cancel_download_job(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_cancel_download_job(p_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.bom_cancel_download_job(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.bom_cancel_download_job(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION bom_cancel_ext_sync_job(p_job_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_cancel_ext_sync_job(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_cancel_ext_sync_job(p_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.bom_cancel_ext_sync_job(p_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.bom_cancel_ext_sync_job(p_job_id uuid) TO service_role;


--
-- Name: FUNCTION bom_claim_download_job(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_claim_download_job() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_claim_download_job() TO anon;
GRANT ALL ON FUNCTION public.bom_claim_download_job() TO service_role;


--
-- Name: FUNCTION bom_claim_ext_sync_job(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_claim_ext_sync_job() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_claim_ext_sync_job() TO anon;
GRANT ALL ON FUNCTION public.bom_claim_ext_sync_job() TO service_role;


--
-- Name: FUNCTION bom_dashboard_stats(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_dashboard_stats() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_dashboard_stats() TO anon;
GRANT ALL ON FUNCTION public.bom_dashboard_stats() TO authenticated;
GRANT ALL ON FUNCTION public.bom_dashboard_stats() TO service_role;


--
-- Name: FUNCTION bom_extract_download_url(p_row jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_extract_download_url(p_row jsonb) TO anon;
GRANT ALL ON FUNCTION public.bom_extract_download_url(p_row jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.bom_extract_download_url(p_row jsonb) TO service_role;


--
-- Name: FUNCTION bom_extract_expected_md5(p_row jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_extract_expected_md5(p_row jsonb) TO anon;
GRANT ALL ON FUNCTION public.bom_extract_expected_md5(p_row jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.bom_extract_expected_md5(p_row jsonb) TO service_role;


--
-- Name: FUNCTION bom_extract_ext_url(p_row jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_extract_ext_url(p_row jsonb) TO anon;
GRANT ALL ON FUNCTION public.bom_extract_ext_url(p_row jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.bom_extract_ext_url(p_row jsonb) TO service_role;


--
-- Name: FUNCTION bom_fail_stale_download_jobs(p_stale_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_fail_stale_download_jobs(p_stale_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_fail_stale_download_jobs(p_stale_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.bom_fail_stale_download_jobs(p_stale_seconds integer) TO service_role;


--
-- Name: FUNCTION bom_fail_stale_ext_sync_jobs(p_stale_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_fail_stale_ext_sync_jobs(p_stale_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_fail_stale_ext_sync_jobs(p_stale_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.bom_fail_stale_ext_sync_jobs(p_stale_seconds integer) TO service_role;


--
-- Name: FUNCTION bom_fail_stale_scan_jobs(p_stale_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_fail_stale_scan_jobs(p_stale_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_fail_stale_scan_jobs(p_stale_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.bom_fail_stale_scan_jobs(p_stale_seconds integer) TO service_role;


--
-- Name: FUNCTION bom_file_basename(p_path text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_file_basename(p_path text) TO anon;
GRANT ALL ON FUNCTION public.bom_file_basename(p_path text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_file_basename(p_path text) TO service_role;


--
-- Name: FUNCTION bom_finalize_scan(p_job_id uuid, p_success boolean, p_files_seen integer, p_files_md5_updated integer, p_files_removed integer, p_message text, p_prune_missing boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_finalize_scan(p_job_id uuid, p_success boolean, p_files_seen integer, p_files_md5_updated integer, p_files_removed integer, p_message text, p_prune_missing boolean) TO anon;
GRANT ALL ON FUNCTION public.bom_finalize_scan(p_job_id uuid, p_success boolean, p_files_seen integer, p_files_md5_updated integer, p_files_removed integer, p_message text, p_prune_missing boolean) TO authenticated;
GRANT ALL ON FUNCTION public.bom_finalize_scan(p_job_id uuid, p_success boolean, p_files_seen integer, p_files_md5_updated integer, p_files_removed integer, p_message text, p_prune_missing boolean) TO service_role;


--
-- Name: FUNCTION bom_mark_scan_started(p_job_id uuid, p_message text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_mark_scan_started(p_job_id uuid, p_message text) TO anon;
GRANT ALL ON FUNCTION public.bom_mark_scan_started(p_job_id uuid, p_message text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_mark_scan_started(p_job_id uuid, p_message text) TO service_role;


--
-- Name: FUNCTION bom_refresh_local_found_statuses(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_refresh_local_found_statuses() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_refresh_local_found_statuses() TO anon;
GRANT ALL ON FUNCTION public.bom_refresh_local_found_statuses() TO service_role;


--
-- Name: FUNCTION bom_refresh_local_found_statuses_for_batch(p_batch_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_refresh_local_found_statuses_for_batch(p_batch_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_refresh_local_found_statuses_for_batch(p_batch_id uuid) TO anon;
GRANT ALL ON FUNCTION public.bom_refresh_local_found_statuses_for_batch(p_batch_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.bom_refresh_local_found_statuses_for_batch(p_batch_id uuid) TO service_role;


--
-- Name: FUNCTION bom_request_download(p_batch_id uuid, p_row_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.bom_request_download(p_batch_id uuid, p_row_ids uuid[]) TO service_role;


--
-- Name: FUNCTION bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.bom_request_ext_sync(p_batch_id uuid, p_row_ids uuid[]) TO service_role;


--
-- Name: FUNCTION bom_request_scan(p_trigger_source text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_request_scan(p_trigger_source text) TO anon;
GRANT ALL ON FUNCTION public.bom_request_scan(p_trigger_source text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_request_scan(p_trigger_source text) TO service_role;


--
-- Name: FUNCTION bom_row_download_targets(p_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_row_download_targets(p_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_row_download_targets(p_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.bom_row_download_targets(p_ids uuid[]) TO service_role;


--
-- Name: FUNCTION bom_row_still_eligible_for_ext_sync(p_row_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_row_still_eligible_for_ext_sync(p_row_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_row_still_eligible_for_ext_sync(p_row_id uuid) TO anon;
GRANT ALL ON FUNCTION public.bom_row_still_eligible_for_ext_sync(p_row_id uuid) TO service_role;


--
-- Name: FUNCTION bom_row_still_eligible_for_it_download(p_row_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_row_still_eligible_for_it_download(p_row_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_row_still_eligible_for_it_download(p_row_id uuid) TO anon;
GRANT ALL ON FUNCTION public.bom_row_still_eligible_for_it_download(p_row_id uuid) TO service_role;


--
-- Name: FUNCTION bom_rows_for_it_download(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_rows_for_it_download(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_rows_for_it_download(p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.bom_rows_for_it_download(p_limit integer) TO service_role;


--
-- Name: FUNCTION bom_sync_bom_row_local_size_from_index(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_sync_bom_row_local_size_from_index() FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_sync_bom_row_local_size_from_index() TO anon;
GRANT ALL ON FUNCTION public.bom_sync_bom_row_local_size_from_index() TO authenticated;
GRANT ALL ON FUNCTION public.bom_sync_bom_row_local_size_from_index() TO service_role;


--
-- Name: FUNCTION bom_upsert_local_file(p_job_id uuid, p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_upsert_local_file(p_job_id uuid, p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) TO anon;
GRANT ALL ON FUNCTION public.bom_upsert_local_file(p_job_id uuid, p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_upsert_local_file(p_job_id uuid, p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) TO service_role;


--
-- Name: FUNCTION bom_upsert_local_file_web(p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bom_upsert_local_file_web(p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bom_upsert_local_file_web(p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) TO anon;
GRANT ALL ON FUNCTION public.bom_upsert_local_file_web(p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_upsert_local_file_web(p_path text, p_size_bytes bigint, p_mtime timestamp with time zone, p_md5 text) TO service_role;


--
-- Name: FUNCTION bom_url_looks_like_it_artifactory(p text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_url_looks_like_it_artifactory(p text) TO anon;
GRANT ALL ON FUNCTION public.bom_url_looks_like_it_artifactory(p text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_url_looks_like_it_artifactory(p text) TO service_role;


--
-- Name: FUNCTION bom_url_path_basename(p text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.bom_url_path_basename(p text) TO anon;
GRANT ALL ON FUNCTION public.bom_url_path_basename(p text) TO authenticated;
GRANT ALL ON FUNCTION public.bom_url_path_basename(p text) TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: TABLE bom_batches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bom_batches TO anon;
GRANT ALL ON TABLE public.bom_batches TO authenticated;
GRANT ALL ON TABLE public.bom_batches TO service_role;


--
-- Name: TABLE bom_download_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bom_download_jobs TO anon;
GRANT ALL ON TABLE public.bom_download_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_download_jobs TO service_role;


--
-- Name: TABLE bom_ext_sync_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bom_ext_sync_jobs TO anon;
GRANT ALL ON TABLE public.bom_ext_sync_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_ext_sync_jobs TO service_role;


--
-- Name: TABLE bom_rows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bom_rows TO anon;
GRANT ALL ON TABLE public.bom_rows TO authenticated;
GRANT ALL ON TABLE public.bom_rows TO service_role;


--
-- Name: TABLE bom_scan_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bom_scan_jobs TO anon;
GRANT ALL ON TABLE public.bom_scan_jobs TO authenticated;
GRANT ALL ON TABLE public.bom_scan_jobs TO service_role;


--
-- Name: TABLE local_file; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_file TO anon;
GRANT ALL ON TABLE public.local_file TO authenticated;
GRANT ALL ON TABLE public.local_file TO service_role;


--
-- Name: TABLE products; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.products TO anon;
GRANT ALL ON TABLE public.products TO authenticated;
GRANT ALL ON TABLE public.products TO service_role;


--
-- Name: TABLE system_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_settings TO anon;
GRANT ALL ON TABLE public.system_settings TO authenticated;
GRANT ALL ON TABLE public.system_settings TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--



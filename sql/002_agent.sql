-- Phase 2 — agent ki apni tables
--
-- Agent jo bhi likhta hai wo YAHAN likhta hai. Source MySQL aur uski
-- `source` schema copy — dono sirf padhi jaati hain.

-- Call ke dauran banaye gaye notes / reminders
CREATE TABLE IF NOT EXISTS public.agent_note (
  id         serial PRIMARY KEY,
  text       text NOT NULL,
  about      text,
  source     text NOT NULL DEFAULT 'call',
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Har call ka record — debugging ke liye bhi, audit ke liye bhi
CREATE TABLE IF NOT EXISTS public.call_log (
  id            serial PRIMARY KEY,
  caller_number text,
  caller_name   text,
  direction     text NOT NULL DEFAULT 'inbound',
  authorised    boolean NOT NULL DEFAULT false,
  auth_failure  text,
  transcript    jsonb,
  tools_used    text[],
  duration_sec  integer,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz
);

CREATE INDEX IF NOT EXISTS call_log_started_idx ON public.call_log (started_at DESC);

-- Kaun call kar sakta hai. E.164 format: +919876543210
-- Caller ID spoof ho sakti hai, isliye PIN alag se check hota hai.
CREATE TABLE IF NOT EXISTS public.allowed_caller (
  phone      text PRIMARY KEY,
  name       text NOT NULL,
  pin        text,
  can_hear_money boolean NOT NULL DEFAULT false,
  active     boolean NOT NULL DEFAULT true,
  added_at   timestamptz NOT NULL DEFAULT now()
);

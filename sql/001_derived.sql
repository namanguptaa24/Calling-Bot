-- Phase 1 — derived layer
--
-- Sab kuch `public` schema mein banta hai. `source` (MySQL ki copy) sirf
-- padhi jaati hai, kabhi badli nahi — isliye `npm run copy -- --fresh`
-- chalane pe ye sab bacha rehta hai.
--
-- Yahan koi DROP nahi hai. Sab CREATE ... IF NOT EXISTS / OR REPLACE.

-- ════════════════════════════════════════════════════════════════
-- 1. Client alias — free-text client_name ko clients.id se jodna
-- ════════════════════════════════════════════════════════════════
-- 136 distinct naamon mein se 133 seedha match ho jaate hain.
-- Ye table sirf un teen ke liye hai jo nahi hote.

CREATE TABLE IF NOT EXISTS public.client_alias (
  raw_name  text PRIMARY KEY,
  client_id integer,          -- NULL = jaan-boojhkar unmapped
  note      text,
  added_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.client_alias (raw_name, client_id, note) VALUES
  ('e-Marketing (Operations)',
   (SELECT id FROM source.clients WHERE name = 'E-Marketing(Operation)'),
   'spelling variant'),
  ('Atit',
   (SELECT id FROM source.clients WHERE name = 'Atit Engineeing Industries'),
   'short form'),
  ('Onpint Express',
   NULL,
   'clients table mein hai hi nahi — confirm karna padega')
ON CONFLICT (raw_name) DO NOTHING;

-- ════════════════════════════════════════════════════════════════
-- 2. Staff — 53 users mein se 13 client logins hain
-- ════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.staff AS
SELECT id, name, email, role::text AS role, department, phone,
       week_off, joining_date, exclude_from_reminder
  FROM source.users
 WHERE role::text <> 'client';

-- ════════════════════════════════════════════════════════════════
-- 3. Timesheet — client resolve + outlier flag
-- ════════════════════════════════════════════════════════════════
-- 12 ghante (720 min) se lambi ek entry data entry ki galti hai.
-- Poore dataset mein aisi sirf 1 row hai (4000 min). Flag karo,
-- chupchaap jodo mat — warna agent "98 ghante" bolega.

CREATE OR REPLACE VIEW public.daily_task AS
SELECT d.id,
       d.user_id,
       d.entry_date,
       d.department,
       d.description,
       d.duration_min,
       trim(d.client_name)               AS raw_client_name,
       COALESCE(c.id, a.client_id)       AS client_id,
       (d.duration_min > 720)            AS is_outlier,
       (c.id IS NULL AND a.raw_name IS NULL
        AND trim(COALESCE(d.client_name,'')) <> '') AS is_unmapped
  FROM source.daily_tasks d
  LEFT JOIN source.clients c
         ON lower(trim(c.name)) = lower(trim(d.client_name))
  LEFT JOIN public.client_alias a
         ON a.raw_name = trim(d.client_name);

-- ════════════════════════════════════════════════════════════════
-- 4. Open tasks — delegation + checklist ek jagah
-- ════════════════════════════════════════════════════════════════
-- Dono tables ka shape alag hai par sawaal ek hi hai: "kya pending hai".
-- `bucket` overdue / today / future / no_due_date mein baant deta hai —
-- checklist ke 3,747 future items ko overdue ginna sabse badi galti hoti.

CREATE OR REPLACE VIEW public.open_task AS
SELECT 'delegation'                        AS kind,
       t.id,
       t.description,
       t.assigned_to,
       t.assigned_by,
       t.due_date,
       t.status::text                      AS status,
       t.priority::text                    AS priority,
       t.client_id,
       (t.approval::text = 'yes')          AS needs_approval,
       t.remarks,
       t.created_at,
       CASE WHEN t.due_date IS NULL         THEN 'no_due_date'
            WHEN t.due_date < CURRENT_DATE  THEN 'overdue'
            WHEN t.due_date = CURRENT_DATE  THEN 'today'
            ELSE 'future' END               AS bucket,
       CASE WHEN t.due_date < CURRENT_DATE
            THEN (CURRENT_DATE - t.due_date) END AS days_overdue
  FROM source.delegation_tasks t
 WHERE t.status::text <> 'completed'
UNION ALL
SELECT 'checklist',
       t.id, t.description, t.assigned_to, t.assigned_by, t.due_date,
       t.status::text, t.priority::text, t.client_id,
       false, t.remarks, t.created_at,
       CASE WHEN t.due_date IS NULL         THEN 'no_due_date'
            WHEN t.due_date < CURRENT_DATE  THEN 'overdue'
            WHEN t.due_date = CURRENT_DATE  THEN 'today'
            ELSE 'future' END,
       CASE WHEN t.due_date < CURRENT_DATE
            THEN (CURRENT_DATE - t.due_date) END
  FROM source.checklist_tasks t
 WHERE t.status::text <> 'completed';

-- ════════════════════════════════════════════════════════════════
-- 5. Baar-baar khiskne wale tasks
-- ════════════════════════════════════════════════════════════════
-- task_activity mein due_date 167 baar badli gayi hai. Jis task ki
-- due date 2+ baar aage badhi, wo atka hua hai — chahe "pending" hi dikhe.
-- Ye signal reel wale dashboard mein nahi tha.

CREATE OR REPLACE VIEW public.task_postponed AS
SELECT task_id,
       task_type,
       COUNT(*)::int      AS times_pushed,
       MIN(created_at)    AS first_pushed,
       MAX(created_at)    AS last_pushed
  FROM source.task_activity
 WHERE field = 'due_date'
 GROUP BY task_id, task_type
HAVING COUNT(*) >= 2;

-- ════════════════════════════════════════════════════════════════
-- 6. Utilisation — outlier hataa ke
-- ════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.staff_utilisation_7d AS
SELECT s.id           AS user_id,
       s.name,
       s.department,
       COALESCE(ROUND(SUM(d.duration_min) FILTER (WHERE NOT d.is_outlier) / 60.0, 1), 0) AS hours,
       COUNT(d.id) FILTER (WHERE NOT d.is_outlier)::int  AS entries,
       COUNT(d.id) FILTER (WHERE d.is_outlier)::int      AS outlier_entries,
       MAX(d.entry_date)                                  AS last_logged
  FROM public.staff s
  LEFT JOIN public.daily_task d
         ON d.user_id = s.id AND d.entry_date >= CURRENT_DATE - 7
 GROUP BY s.id, s.name, s.department;

-- ════════════════════════════════════════════════════════════════
-- 7. Client coverage — kis client pe kitne din se kaam nahi hua
-- ════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.client_coverage AS
SELECT c.id            AS client_id,
       c.name,
       c.is_active,
       MAX(d.entry_date)                                   AS last_worked,
       (CURRENT_DATE - MAX(d.entry_date))                  AS days_since,
       COALESCE(ROUND(SUM(d.duration_min) FILTER (
         WHERE d.entry_date >= CURRENT_DATE - 30 AND NOT d.is_outlier) / 60.0, 1), 0)
                                                           AS hours_30d
  FROM source.clients c
  LEFT JOIN public.daily_task d ON d.client_id = c.id
 GROUP BY c.id, c.name, c.is_active;

-- ════════════════════════════════════════════════════════════════
-- 8. Aaj chhutti pe kaun
-- ════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.on_leave_today AS
SELECT s.id AS user_id, s.name, l.leave_type::text AS leave_type,
       l.from_date, l.to_date
  FROM source.leave_requests l
  JOIN public.staff s ON s.id = l.user_id
 WHERE CURRENT_DATE BETWEEN l.from_date AND l.to_date
   AND lower(l.status::text) LIKE 'approve%';

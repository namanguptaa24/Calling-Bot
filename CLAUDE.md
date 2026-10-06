# calling-bot

Agent aapko call karta hai aur batata hai: kis employee ka kaunsa task pending
hai, kis client ka, kab se. Outbound briefing — baat-cheet nahi.
Plan: [PLAN.md](PLAN.md) (upar "Revision" section padhna)

## Briefing ke do guard

Script `briefing.ts` mein **SQL se** banta hai. LLM (`polish.ts`) sirf task
description ko chhota karta hai. Do guard hain, dono code mein — prompt mein nahi:

**1. `isFaithful()` — LLM naya shabd nahi la sakta.**
Polished phrase ka har content word original description mein hona chahiye,
warna phrase reject aur truncation chalti hai. Ye zaroori nikla: gpt-4.1-mini ne
asal mein ek bank ka naam badal diya tha — ek description mein "<BankA> ... payment
clear" ko "<BankB> payment clear" bana diya. Prompt mein "kuch mat jodo" likha
hone ke baad bhi.
Kabhi theek phrase bhi reject hoga; wo manzoor hai.

**2. `dataAge()` — purani copy pe briefing rukti hai.**
7 din se purana data → call sirf itna bolti hai ki data purana hai.
2 din se purana → "kisne timesheet nahi bhara" wali baat chhod deti hai
(sync ruke to wo poori team ko badnaam kar deti hai) aur saaf warning deti hai.

Niyam: **koi bhi naya fact query se aaye, LLM ke output se nahi** — aur
us baat ko code se jaancha jaaye, prompt pe bharosa karke nahi.

---

## 🔴 Rule #1 — Database read-only hai

**Source database (`lpcliimp_taskMarketing`, cPanel MySQL) mein kabhi kuch
delete ya modify nahi karna.**

Koi `DELETE`, `UPDATE`, `INSERT`, `DROP`, `TRUNCATE`, `ALTER` — kuch bhi nahi.
Agar kabhi genuinely zaroori lage, to **pehle rukna, exact SQL dikhana, kitni rows
affect hongi wo batana, aur haan ka intezaar karna.** Har baar. Ek baar ki permission
agli baar ke liye nahi chalti.

Ye live production system hai — 53 users, 11,000+ timesheet entries, roz active use.

### Har DB script mein ye 4 guards zaroori hain

`scripts/dump-schema.mjs` reference implementation hai:

1. Har query `SELECT` ya `SHOW` se shuru ho — code mein hi
2. Runtime assert — koi doosri query ho to process exit
3. `multipleStatements: false` — `"; DELETE"` smuggle na ho sake
4. `START TRANSACTION READ ONLY` — server khud DML reject karta hai

Chalne ke baad har query audit output mein print hoti hai.

### Kabhi sync mat karna

`users.password` · `client_credentials` · `login_attempts` · `reset_otp_*` columns

Agent ko inki zaroorat kabhi nahi hai.

### Write-back kahan jaata hai

Agent ka `create_note` feature (Phase 3) **apni Postgres** mein likhega.
cPanel MySQL hamesha read-only rahegi, dono direction mein clear boundary.

---

## Deployed service

`npm start` → `apps/agent/src/server.ts`. Railway pe `railway.toml` se chalta hai,
Postgres ke bagal mein (isiliye query latency 240ms se gir ke <10ms ho jaati hai).

| Endpoint | Kya |
|---|---|
| `GET /health` | data kitni purani, sync/vapi on hai ya nahi, agli briefing kab |
| `GET /briefing` | call pe kya bola jayega — call kiye bina |
| `POST /briefing/call` | abhi call karo (cron ka intezaar nahi) |
| `POST /sync` | abhi sync karo |

Scheduler (IST): sync `*/15 * * * *`, briefing `0 10 * * 1-6`.

**Har hissa apne credentials ke bina chup-chaap skip hota hai.** Ye
jaan-boojhkar hai — aadha setup bhi deploy ho sakta hai aur baaki baad mein
judta hai. `/health` saaf batata hai ki kya missing hai.

**`numReplicas` 1 hi rakhna** — scheduler har instance mein chalta hai, do
instance matlab roz do call.

### Sync ek hi transaction mein hoti hai

`source` tables dobara banane se `public` ke views CASCADE mein gir jaate hain.
Isliye reload aur migrations **ek hi transaction** mein chalti hain — commit ke
baad tables aur views dono saboot. Schema *rename* wala tareeka yahan kaam nahi
karta: Postgres views OID se bandhe hote hain, wo purane schema ke peeche chale
jaate hain aur uske DROP CASCADE mein mar jaate hain.

---

## Commands

| Command | Kya karta hai | Kis DB pe |
|---|---|---|
| `npm run briefing` | **Call pe kya bola jayega, wo print karo** | Postgres copy |
| `npm run agent -- --dry` | Snapshot + saare tools, **bina LLM ke** | Postgres copy |
| `npm run agent` | Terminal mein agent se baat karo | Postgres copy |
| `npm run serve` | Agent HTTP API (port 3000) | Postgres copy |
| `npm run typecheck` | `tsc --noEmit` | — |
| `npm run snapshot` | BusinessSnapshot banata hai → `snapshot.json` | Postgres copy |
| `npm run sanity` | Copy pe sanity queries | Postgres copy |
| `npm run explore` | Data quality / design ke sawaal | Postgres copy |
| `npm run migrate` | `sql/*.sql` apply karta hai (`public` schema) | Postgres copy |
| `npm run schema` | MySQL ka schema dump | ⚠️ production |
| `npm run copy` | MySQL → Postgres full copy | ⚠️ production |

Aakhri do tabhi chalti hain jab `.env` mein `DB_*` credentials hon.
**Wo jaan-boojhkar hata rakhe hain** — matlab default haalat mein koi script
production ko chhu hi nahi sakti. Re-sync ke waqt daalo, kaam hone pe hata do.

`.env` gitignored hai. `.env.example` commit hoti hai — usme kabhi asli
credentials mat daalna.

## Schemas

- **`source`** — MySQL ki hubahu copy. Read-only. `npm run copy -- --fresh` isi ko
  reset karta hai.
- **`public`** — humara derived layer (`sql/001_derived.sql`). Copy dobara karne pe
  bacha rehta hai.

---

## Data ki asliyat (Phase 0, 15 Sep 2026)

Source DB ek **task/HR system hai, finance system nahi.** Jab feature socho
to yaad rakhna:

**Hai:** `daily_tasks` (11,307 — asli timesheet, `duration_min` ke saath) ·
`delegation_tasks` (2,261) · `checklist_tasks` (5,435) · `task_activity` (audit
trail) · `clients` (288) · `users` (53) · `meetings` · `leave_requests` · `week_plans`

**Nahi hai:** invoices · revenue · sales pipeline · vendor credits.
Paisa sirf kharche ka hai (`cc_transactions`, `payment_requests`).

**Mara hua data — ignore karo:** `tasks` (4 rows, legacy — `delegation_tasks` ne
replace kiya) · `day_plan_items` · `config` · `message_logs` · `email_log` ·
`dms_external_links`

**Soft deletes:** `deleted_records` table hai (798 rows) — counts nikalte waqt
dhyan rakhna.

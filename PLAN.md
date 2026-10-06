# Business Voice Agent — Architecture & Build Plan

> Agent **aapko call karta hai** aur batata hai: kis employee ka kaunsa task pending hai,
> kis client ka, aur kab se. Aap sunte ho, bolna nahi padta.

Inspiration: @manthanjethwani ka "Phaze AI" reel. Neeche uska internal version hai,
aapke apne agency data ke upar.

---

## ⚠️ Revision — 15 Sep 2026

Asli zaroorat spasht hui to plan badla. Neeche ke section (3-9) **us purane version ke**
hain jab do-tarfa baat-cheet soch rahe the. Jo ab sach hai:

| | Pehle socha tha | Ab |
|---|---|---|
| Call | Aap dial karo, baat karo | **Agent call kare, aap suno** |
| Direction | Inbound | **Outbound** — Indian inbound number ka jhanjhat khatam |
| Script | LLM har turn pe banata | **SQL se banta hai.** LLM sirf task description ko bolne layak chhota karta hai — numbers, naam, tareekh use dikhte hi nahi |
| Timing | Jab aap yaad karo | **Roz subah, Mon-Sat**, ~100 second |
| LLM cost | ~₹2,100/month (Opus, per-turn) | **~₹15/month** — ek call mein ek hi LLM request |
| Auth | Caller allowlist + PIN | Outbound hai, to zaroorat nahi. Code bana hua hai, inbound kabhi chahiye to lag jayega |

**Telephony ki asliyat** (docs se confirm kiya): Vapi ke free number pe outbound
hai hi nahi — wo sirf US inbound hai. India pe call karne ke liye apna Twilio number
chahiye jispe India geo permission enabled ho, phir usko Vapi mein import karo.

Conversational agent ka code (`agent.ts`, `tools.ts`, `prompt.ts`, `auth.ts`,
`server.ts`) bana hua hai aur chalta hai — `npm run agent` se. Briefing chalne ke
baad agar "follow-up poochh saku" wali zaroorat aayi to wo pehle se taiyaar hai.

---

## 1. Locked decisions

| Decision | Choice | Kyun |
|---|---|---|
| Scope | **Internal** — sirf E-Marketing Tech ke liye | Single tenant. No auth system, no billing, no onboarding. 3x kam kaam. |
| Data source | **cPanel MySQL** | Jo hai usi se kaam chalana hai, naya CRM nahi lena. |
| Stack | **Node.js + TypeScript** | Vapi/Twilio/Meta ke best SDKs. Dashboard bhi same repo mein Next.js. |
| Hosting | **Railway** | Aapke system pe Railway CLI already hai. Static egress IP milta hai — cPanel whitelisting ke liye zaroori. |

---

## 2. ⚠️ Assumption jo verify karni hai

Maine maana hai ki aapka business data (projects, clients, invoices, team) **cPanel hosting pe
ek ya zyada MySQL databases** mein hai.

Phase 0 shuru karne se pehle 3 cheezein confirm karni hongi:

1. **Kaunsi tables/DBs** mein kya hai? (client list, projects, invoices, staff)
2. **Remote MySQL access** available hai? cPanel → "Remote MySQL" section mein IP whitelist kar sakte ho?
3. Agar nahi — to cPanel pe **PHP file host karne ki permission** hai? (Plan B ke liye)

Agar data structured nahi hai aur sab WhatsApp/Excel mein bikhra hai, to plan badal jaayega —
Phase 0 lamba ho jaayega aur pehle data entry layer banani padegi.

---

## 3. Architecture

```
  ┌─────────────┐         ┌──────────────────────────────────────────┐
  │   📞 Aap     │◄───────►│  Vapi (voice agent)                      │
  │  (phone)    │  call   │  STT → LLM → TTS, turn-taking, barge-in  │
  └─────────────┘         └───────────────┬──────────────────────────┘
                                          │ webhook + tool calls
                                          ▼
                          ┌──────────────────────────────────────────┐
                          │  Agent API  (Node + TS, Railway)         │
                          │  ├── /vapi/webhook                       │
                          │  ├── /tools/*     ← 7 typed functions    │
                          │  └── /cron/*      ← alerts + sync        │
                          └───────┬──────────────────────┬───────────┘
                                  │ reads                │ reads/writes
                                  ▼                      ▼
                    ┌──────────────────────┐   ┌────────────────────┐
                    │  Snapshot (Redis)    │   │  Postgres (Neon)   │
                    │  poora business      │   │  normalised copy   │
                    │  state, 1 JSON       │   │  + derived metrics │
                    │  refresh: 10 min     │   │  + notes/tasks     │
                    └──────────────────────┘   └─────────▲──────────┘
                                                         │ sync job (15 min)
                                               ┌─────────┴──────────┐
                                               │  cPanel MySQL      │
                                               │  (read-only)       │
                                               └────────────────────┘
                                                         ▲
                                               ┌─────────┴──────────┐
                                               │  Dashboard         │
                                               │  Next.js (Phase 5) │
                                               └────────────────────┘
```

### Sabse important design decision

**Live call ke dauran database query mat maaro.**

Voice mein 800ms se zyada silence awkward lagti hai. Ek MySQL round-trip cPanel shared hosting se
300–800ms le sakta hai; 3 queries = call dead.

Isliye: **pre-computed snapshot**. Ek single JSON object jisme poora business state hai,
har 10 minute refresh hota hai, Redis mein baitha hai. Call start hote hi wo system prompt
mein chala jaata hai. Agent ka pehla jawaab **instant** hota hai — koi tool call nahi.

Tools sirf **drill-down** ke liye hain ("Trilok Dental ka detail batao") jahan 1-second pause
natural lagta hai.

---

## 4. Components

### 4.1 Data layer — cPanel se nikalna

Do raaste, aapke hosting ke hisaab se:

**Plan A — Remote MySQL (agar allowed hai)**

```
cPanel → Remote MySQL → Railway ka static egress IP whitelist karo
Node se mysql2 se direct connect, read-only DB user ke saath
```

Saaf aur simple. Zaroori: cPanel pe ek **read-only MySQL user** banao (`SELECT` only).
Kabhi bhi apne main DB user ke credentials agent ko mat do.

**Plan B — Thin PHP extract endpoint (shared hosting ke liye)**

```php
// cPanel pe: /api/extract.php
// localhost se MySQL padhta hai, JSON return karta hai
// Bearer token + IP allowlist se protected
```

Shared hosting pe zyada tar yahi chalega, kyunki remote MySQL aksar band hota hai.
Thoda ganda lagta hai par reliable hai.

**Dono cases mein:** raw data **Postgres (Neon free tier)** mein sync hota hai.
Yeh sirf copy nahi hai — yahan aap wo derived cheezein compute karte ho jo aapke
cPanel DB mein exist hi nahi karti:

- utilisation % per person
- invoice aging buckets (0-30, 31-60, 60+ days overdue)
- "blocked since" duration
- project progress %
- vendor credit burn rate → kitne din bache hain

Yahi difference hai ek dashboard aur ek *agent* mein. Agent ko **judgement** chahiye,
raw rows nahi.

### 4.2 Business snapshot

Ek typed object, har 10 min rebuild hota hai:

```typescript
type BusinessSnapshot = {
  generatedAt: string;
  money: {
    revenueThisMonth: number;
    marginPct: number;
    owedToYou: { client: string; invoice: string; amount: number; daysOverdue: number }[];
    totalOverdue: number;
  };
  projects: {
    liveCount: number;
    valueInPlay: number;
    blocked: { name: string; client: string; blockedOn: string; daysBlocked: number }[];
    waitingOnYou: { name: string; action: string; valueHeldUp: number }[];
  };
  team: {
    presentToday: number;
    totalHeadcount: number;
    utilisationPct: number;
    idle: { name: string; reason: string }[];
    atCapacity: string[];
  };
  vendors: {
    runningLow: { name: string; remainingPct: number; estDaysLeft: number }[];
    delayed: { vendor: string; item: string; newEta: string }[];
  };
  sales: {
    newEnquiries: number;
    quotesPending: { client: string; amount: number; daysSince: number }[];
  };
  attentionItems: string[]; // ← LLM ke liye pre-ranked, top 3-5
};
```

`attentionItems` sabse zaroori field hai. Yeh **code** decide karta hai (rules se), LLM nahi —
matlab "aaj kya important hai" deterministic hai, har call pe alag nahi hoga.

### 4.3 Agent tools

Sirf 7. Zyada tools = LLM confuse hota hai aur latency badhti hai.

| Tool | Kaam |
|---|---|
| `get_project(name)` | Ek project ka poora detail, history ke saath |
| `get_person(name)` | Kaun kis pe kaam kar raha hai, capacity, blockers |
| `get_client(name)` | Client ka revenue, live projects, pending invoices |
| `get_invoice_details(filter)` | Overdue/pending invoices, aging ke saath |
| `get_vendor_usage()` | Credits, limits, delivery status |
| `search_activity(query, days)` | "pichhle hafte Sharma ke saath kya hua?" |
| `create_note(text, assignee?)` | **Write-back** — call ke dauran task/reminder banao |

Aakhri wala sabse under-rated hai. Sirf sunne wala agent ek report hai; jo **kaam record kar sake**
wo assistant hai. "Sneha ko bolo Trilok ka approval chase kare" → task ban gaya.

### 4.4 Telephony — yahan ek asli problem hai

Reel mein **US number** (+1 350-226-0936) use hua hai. Yeh coincidence nahi hai.

**India mein voice numbers regulated hain.** Twilio pe Indian number lene ke liye regulatory
bundle + local address proof chahiye, aur inbound/outbound pe restrictions hain. Process
hafton chal sakta hai.

Options, practicality ke hisaab se:

| Option | Setup time | Trade-off |
|---|---|---|
| **Vapi ka US number** (dev ke liye) | 5 minute | India se call karne pe ISD charge lagega aapko. Testing ke liye perfect. |
| **Plivo / Exotel India number** | 1–2 hafte (KYC) | Sahi production raasta. Exotel India-first hai, compliance samajhta hai. |
| **Vapi Web/Mobile SDK** | 1 din | "Phone call" ka jaadu nahi, par zero telephony compliance. Internal use ke liye kaafi. |

**Meri salah:** Phase 2 mein Vapi ke US number se banao aur test karo. Jab agent actually
useful lage, tab Exotel ka India number ka KYC shuru karo. Telephony compliance pe pehle
2 hafte mat waste karo jab tak pata na ho ki agent kaam ka hai.

### 4.5 Security — reel ne yeh part poora chhupaya hai

Aap ek phone number bana rahe ho jo poocho to **revenue, margins, salaries aur client names**
bol dega. Jisko number mil gaya, usko sab mil gaya.

Minimum jo chahiye:

1. **Caller ID allowlist** — sirf registered numbers connect ho sakein. Baaki ke liye agent
   uthta hi nahi.
2. **Spoken PIN** — 4-digit, financial data se pehle. Caller ID spoof ho sakti hai.
3. **Tiered access** — aapko sab milta hai; team member ko sirf apne projects (agar kabhi
   unko diya).
4. **Har call ka log** — kisne call kiya, kya poocha, kya jawaab mila. Debugging ke liye bhi,
   audit ke liye bhi.

Yeh Phase 2 mein banega, baad mein nahi. Retrofit karna hamesha mushkil hota hai.

### 4.6 Dashboard — sabse aakhir mein

Reel ka 70% hissa dashboard hai. Yeh **camera ke liye** hai. Aapko wo dashboard nahi chahiye
agent kaam karne ke liye — data layer chahiye, aur wo Phase 1 mein ban jaata hai.

Dashboard Phase 5 mein banega, usi Postgres se padhega. Tab tak aapko pata chal chuka hoga
ki kaunse views actually kaam ke hain — kyunki aap dekh chuke honge ki aap agent se kya
poochte ho.

---

## 5. Repo structure

```
calling-bot/
├── apps/
│   ├── agent/                    # Node + TS API — Railway pe
│   │   ├── src/
│   │   │   ├── routes/vapi.ts        # webhook, tool dispatch
│   │   │   ├── tools/                # 7 tool implementations
│   │   │   ├── snapshot/
│   │   │   │   ├── build.ts          # snapshot banata hai
│   │   │   │   └── attention.ts      # ranking rules
│   │   │   ├── sync/
│   │   │   │   ├── cpanel.ts         # MySQL / PHP endpoint reader
│   │   │   │   └── transform.ts      # → Postgres
│   │   │   ├── alerts/rules.ts       # outbound trigger conditions
│   │   │   └── auth/callerAuth.ts    # allowlist + PIN
│   │   └── prompts/agent.md          # system prompt (version controlled!)
│   └── dashboard/                # Next.js — Phase 5
├── packages/
│   ├── db/                       # Drizzle schema + migrations
│   └── types/                    # BusinessSnapshot, shared types
└── PLAN.md
```

System prompt ko **file mein** rakhna, Vapi dashboard mein nahi. Wo aapke product ka sabse
zyada iterate hone wala hissa hai — git history chahiye hogi.

---

## 6. Phases

Estimates ek developer part-time ke hisaab se hain.

### Phase 0 — Data reality check · ~3 din

- cPanel MySQL ka schema map karo: kaunsi table mein kya
- Remote MySQL vs PHP endpoint — decide karo
- Read-only DB user banao
- `BusinessSnapshot` type finalise karo — **asli data ke saath**, kalpana se nahi

**Done jab:** ek TS file hai jo aapke asli data ka accurate shape describe karti hai,
aur aapko pata hai ki har field kahan se aayegi.

⚠️ Yahi phase plan ko bana ya bigaad sakta hai. Agar data gandha hai (inconsistent client names,
missing dates, half-filled rows) to agent confidently galat jawaab dega. Aage badhne se pehle
pata hona chahiye.

### Phase 1 — Data pipeline · ~1 hafta

- cPanel → Postgres sync (har 15 min)
- Derived metrics compute: utilisation, aging, burn rate, blocked duration
- Snapshot builder + Redis cache
- `attentionItems` ranking rules

**Done jab:** `GET /snapshot` 200ms mein sahi, live business state return karta hai.
Abhi tak koi voice nahi. Isko terminal se dekh ke verify karo.

### Phase 2 — Inbound voice agent · ~1 hafta

- Vapi assistant + US dev number
- Webhook + caller allowlist + PIN
- System prompt with snapshot injection
- 3 core tools: `get_project`, `get_person`, `get_invoice_details`
- Call logging

**Done jab:** aap number dial karte ho, PIN dete ho, aur 5 second ke andar sunte ho:
*"Teen cheezein dhyan dene layak hain. Bansal Fitness ka invoice 62 din overdue hai, ek lakh bees hazaar.
Sneha do din se blocked hai Trilok Dental approval pe. Aur OpenAI credits mein 12% bache hain,
lagbhag 4 din."*

### Phase 3 — Depth · ~1 hafta

- Baaki 4 tools (`get_client`, `get_vendor_usage`, `search_activity`, `create_note`)
- Hindi + English dono (Indian English TTS voice zaroori hai — US accent sunne mein ajeeb lagega)
- Prompt tuning: choti baat, numbers bolne ka sahi tareeka ("ek lakh bees hazaar", "one twenty thousand" nahi)
- Interruption handling

**Done jab:** aap 3 minute ki natural baat kar sakte ho aur wo sahi rehta hai.

### Phase 4 — Proactive outbound · ~4 din

Yahan se yeh tool "cool demo" se "actually useful" banta hai.

Cron rules jo **aapko** call karte hain:

- koi bhi credit < 15% ya < 3 din
- invoice 45+ din overdue
- koi 2+ din se blocked
- project jo aapke action pe atka hai, 3+ din
- daily 9:30 AM briefing call (optional, on/off)

Rate limit zaroori: **max 2 outbound call per day**. Warna aap ignore karne lagoge,
aur tab tool bekaar ho gaya.

**Done jab:** OpenAI credits 15% se neeche giraao (test), aur 10 min ke andar phone bajta hai.

### Phase 5 — Dashboard · ~1.5 hafta

- Next.js, Postgres se
- 6 pages: Overview, Money, Sales, Projects, Vendors, Team
- Call history + transcripts (yeh reel mein nahi hai par aapko chahiye hoga)

**Done jab:** aapko dashboard dekhne ka mann kare — agent ko believe karne ke liye nahi.

**Total: ~5–6 hafte** Phase 0 se Phase 5 tak. **Phase 2 ke end tak (~2.5 hafte) hi
80% value mil jaati hai.**

---

## 7. Monthly cost (internal use, din ke 3-5 call)

| Item | ~Cost |
|---|---|
| Vapi (platform + STT + TTS) | $0.10–0.15 / minute |
| Voice minutes (~100 min/month) | ~$12 |
| Phone number | $2–5 |
| LLM tokens | < $5 (snapshot chhota hai, calls kam) |
| Neon Postgres | $0 (free tier kaafi hai) |
| Redis (Upstash) | $0 (free tier) |
| Railway | ~$5 |
| **Total** | **~$25–30 / month** |

Exotel India number lene pe thoda badh sakta hai. Volume se zyada **latency** dekhna
important hai — har extra second irritation hai.

---

## 8. Risks — seedhi baat

1. **Data quality sabse bada risk hai, code nahi.** Agent apne data se behtar nahi ho sakta.
   Agar project status manually update hote hain aur 4 din purane hain, to agent aatmvishwas ke
   saath purani baat bolega. Yeh galat jawaab se zyada khatarnak hai, kyunki sunne mein sahi lagta hai.

2. **Reel data entry ka problem chhupata hai.** Un sundar cards mein "Blocked — waiting on Voice
   Assistant approval" kisi ne *type* kiya hai. Koi AI usko magically nahi jaanta. Sochna padega
   ki yeh data roz update kaun karega — warna 3 hafte mein system sad ho jaayega.

3. **Voice latency nirdayi hai.** Text chat mein 2 second theek hai; call pe wo dead air hai.
   Isliye snapshot architecture optional nahi hai.

4. **India telephony compliance.** Upar detail mein likha hai. Isko Phase 4 tak mat chhedo.

5. **Novelty khatam ho jaati hai.** Pehle hafte aap roz call karoge. Uske baad? Isliye
   **Phase 4 (outbound alerts)** asli product hai — tab aapko yaad rakhne ki zaroorat nahi,
   wo aapko dhoondhta hai.

---

## 9. Agla kadam

Phase 0 shuru karne ke liye chahiye:

1. **cPanel MySQL ka schema** — `SHOW TABLES;` ka output, aur 3-4 main tables ka structure.
   (Sensitive data nahi, sirf column names.)
2. **Remote MySQL allowed hai ya nahi** — cPanel mein check karo.
3. Confirm: projects/clients/invoices data sach mein wahan hai? Ya kuch Excel/WhatsApp
   mein bhi hai?

# Calling-Bot

Internal outbound briefing agent. Har subah phone karke batata hai ki kis team
member ka kaunsa task pending hai, kis client ka, aur kab se.

Baat-cheet nahi — ek tarfa briefing, ~100 second.

## Kaise kaam karta hai

```
cPanel MySQL  ──(read-only sync, 15 min)──▶  Postgres copy
                                                   │
                                            derived views
                                                   │
                                            briefing script  ◀── SQL se, LLM se nahi
                                                   │
                                              Vapi ──▶ 📞
```

Script poora SQL se banta hai. LLM (`polish.ts`) sirf task description ko bolne
layak chhota karta hai — use numbers, naam ya tareekhein bheji hi nahi jaati,
aur uske output ko code jaanchta hai ki usne koi naya shabd to nahi jod diya.

Do guard hain jo galat briefing rokte hain:

- **`isFaithful()`** — polished phrase ka har shabd original mein hona chahiye
- **`dataAge()`** — copy purani ho to call jaati hi nahi

## Setup

```bash
npm install
cp .env.example .env      # phir values bharo
npm run migrate           # Postgres mein derived layer
npm run briefing          # call pe kya bola jayega, wo dekho
npm start                 # server + scheduler
```

Details: [CLAUDE.md](CLAUDE.md) · Plan: [PLAN.md](PLAN.md)

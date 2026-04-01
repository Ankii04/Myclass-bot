# AutoClassJoiner — LPU MyClass Auto Attendance Bot

Automatically login and join classes on **myclass.lpu.in** (CodeTantra). Runs 24/7 on Render — works even when your laptop is off.

## Features
- 🔐 Auto-login to myclass.lpu.in
- 📅 Timetable scraping from CodeTantra dashboard
- ✅ Auto-join when a class starts (green status detected)
- ⏰ Cron scheduler (every 2 min, Mon–Sat, 8AM–9PM IST)
- 📊 Web dashboard with real-time status & logs
- 🔄 Self-ping to keep Render free tier alive

## Deploy to Render
1. Fork/clone this repo
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your repo
4. Set runtime to **Docker**
5. Add environment variables:
   - `REG_NUMBER` = your registration number
   - `PASSWORD` = your UMS password
6. Deploy 🚀

## Local Testing
```bash
npm install
REG_NUMBER=12345678 PASSWORD=yourpass node server.js
# Dashboard → http://localhost:3000
```

## Tech Stack
Node.js · Puppeteer · Express · node-cron · Docker

> ⚠️ Credentials are stored as environment variables on Render (encrypted at rest). They are never committed to code.

/**
 * AutoClassJoiner - Smart Server
 *
 * Flow:
 *  1. 8 AM daily  → login, scrape timetable, close browser (sleep)
 *  2. 10 min before each class → wake up, poll every 5 min
 *  3. Class starts → join, stay until class ends
 *  4. Class ends   → close browser (sleep again)
 */

const express = require('express');
const cron    = require('node-cron');
const path    = require('path');
const AutoClassBot = require('./bot');

const app = express();
const bot = new AutoClassBot();
const PORT = process.env.PORT || 3000;

let credentials = {
  regNumber: process.env.REG_NUMBER || '',
  password:  process.env.PASSWORD  || ''
};

let botEnabled          = true;
let scheduledTimers     = [];   // all setTimeout handles
let activePollingInterval = null; // the 5-min polling setInterval

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/status', (req, res) => {
  res.json({
    ...bot.getStatus(),
    botEnabled,
    hasCredentials: !!(credentials.regNumber && credentials.password),
    regNumber: credentials.regNumber,
  });
});

app.post('/api/credentials', (req, res) => {
  const { regNumber, password } = req.body;
  if (!regNumber || !password)
    return res.status(400).json({ error: 'Both fields required.' });
  credentials.regNumber = regNumber;
  credentials.password  = password;
  bot.log(`Credentials updated for ${regNumber.substring(0, 4)}****`);
  res.json({ success: true, message: 'Credentials saved.' });
});

app.post('/api/toggle', (req, res) => {
  botEnabled = !botEnabled;
  if (!botEnabled) {
    cancelAll();
    bot.log('Bot DISABLED.');
  } else {
    bot.log('Bot ENABLED. Will sync at next 8 AM cron.');
  }
  res.json({ success: true, enabled: botEnabled });
});

// Manual force-trigger (bypasses sleep)
app.post('/api/trigger', async (req, res) => {
  if (!credentials.regNumber || !credentials.password)
    return res.status(400).json({ error: 'No credentials set.' });
  bot.log('⚡ Manual trigger from dashboard...');
  const result = await bot.checkAndJoin(credentials.regNumber, credentials.password, true);
  res.json(result);
});

app.get('/api/schedule', (req, res) =>
  res.json({ timetable: bot.dailyTimetable }));

app.get('/api/screenshot', async (req, res) => {
  // If bot is busy (checkAndJoin running), return cached screenshot instantly
  // to avoid request pile-up while the browser is navigating
  if (bot.isRunning) {
    return res.json({ image: bot.latestScreenshot || null, url: bot.getCurrentUrl() });
  }
  const screenshot = await bot.takeScreenshot();
  res.json({ image: screenshot || null, url: bot.getCurrentUrl() });
});

// ── MJPEG Live Stream ────────────────────────────────────────────────────────
const STREAM_FPS_MS = 1000;
const activeStreamClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=mjpegframe',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no',
  });

  let alive = true;
  activeStreamClients.add(res);
  bot.log(`MJPEG stream client connected (${activeStreamClients.size} active).`);

  const writeFrame = (buffer, mime = 'image/jpeg') => {
    if (!alive || res.destroyed) return false;
    try {
      res.write(`--mjpegframe\r\nContent-Type: ${mime}\r\nContent-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write('\r\n\r\n');
      return true;
    } catch { return false; }
  };

  const writePlaceholder = () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">` +
      `<rect width="1280" height="720" fill="#1a1a1a"/>` +
      `<text x="50%" y="50%" fill="#555" font-family="monospace" font-size="22" ` +
      `text-anchor="middle" dominant-baseline="middle">No browser session active</text></svg>`
    );
    writeFrame(svg, 'image/svg+xml');
  };

  writePlaceholder();

  const streamLoop = async () => {
    while (alive && !res.destroyed) {
      try {
        if (bot.page && !bot.page.isClosed()) {
          const buf = await bot.page.screenshot({ type: 'jpeg', quality: 60 });
          if (!writeFrame(buf)) break;
        } else {
          writePlaceholder();
        }
      } catch { writePlaceholder(); }
      await new Promise(r => setTimeout(r, STREAM_FPS_MS));
    }
    cleanup();
  };

  const cleanup = () => {
    alive = false;
    activeStreamClients.delete(res);
    try { res.end(); } catch {}
    bot.log(`MJPEG stream client disconnected (${activeStreamClients.size} remaining).`);
  };

  req.on('close', () => { alive = false; });
  req.on('error', () => { alive = false; });
  streamLoop();
});

app.get('/api/stream/status', (req, res) =>
  res.json({ clients: activeStreamClients.size }));

app.get('/health', (req, res) =>
  res.json({ status: 'ok', uptime: process.uptime() }));

// ─────────────────────────────────────────────
// CORE SMART SCHEDULING
// ─────────────────────────────────────────────

/** Cancel all pending timers and the active polling interval */
function cancelAll() {
  scheduledTimers.forEach(t => clearTimeout(t));
  scheduledTimers = [];
  if (activePollingInterval) {
    clearInterval(activePollingInterval);
    activePollingInterval = null;
    bot.log('🛑 Stopped active polling interval.');
  }
}

/**
 * STEP 1 — Morning sync (runs at 8 AM)
 * Login → scrape today's timetable → close browser
 * → schedule "wake up 10 min before each class"
 */
async function doMorningSyncAndSchedule() {
  if (!botEnabled || !credentials.regNumber || !credentials.password) {
    bot.log('⚠️ Morning sync skipped — bot disabled or no credentials.', 'warn');
    return;
  }

  bot.log('🌅 8 AM Morning sync: logging in to fetch today\'s schedule...');

  const loggedIn = await bot.login(credentials.regNumber, credentials.password);
  if (!loggedIn) {
    bot.log('❌ Morning sync login failed. Will retry at next 8 AM cron.', 'error');
    return;
  }

  const TIMETABLE_URL = 'https://lovelyprofessionaluniversity.codetantra.com/secure/tla/m.jsp';
  await bot.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await bot.switchToListView();
  bot.dailyTimetable = await bot.scrapeClasses();
  bot.lastDailySync  = new Date().toDateString();
  bot.noClassesFoundToday = (bot.dailyTimetable.length === 0);

  bot.log(`📋 Sync complete. Found ${bot.dailyTimetable.length} class(es) today.`);
  bot.dailyTimetable.forEach(c => bot.log(`   • ${c.name} — ${c.time}`));

  // Close browser — go to sleep
  await bot.closeBrowser();
  bot.status = 'sleeping';

  if (bot.dailyTimetable.length === 0) {
    bot.log('🛌 No classes today. Sleeping all day. See you tomorrow!');
    return;
  }

  // Schedule 10-min-before timers for each class
  schedulePreClassTimers(bot.dailyTimetable);
}

/**
 * STEP 2 — Schedule a "wake up 10 min before" timer for every class
 */
function schedulePreClassTimers(classes) {
  cancelAll();
  const now = Date.now();

  classes.forEach(classInfo => {
    const startMs = bot.parseSingleTime(classInfo.time.split(/[-]|to/i)[0]);
    const endMs   = bot.parseEndTime(classInfo.time);

    if (!startMs || !endMs) {
      bot.log(`⚠️ Could not parse time for "${classInfo.name}" — skipping.`, 'warn');
      return;
    }

    // Already ended
    if (now >= endMs) {
      bot.log(`⏭️ "${classInfo.name}" has already ended — skipping.`);
      return;
    }

    const wakeMs  = startMs - 10 * 60 * 1000; // 10 min before start
    const delayMs = wakeMs - now;

    if (delayMs > 0) {
      // Class hasn't started yet and still > 10 min away
      const wakeTime = new Date(wakeMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      bot.log(`⏰ "${classInfo.name}" — will wake at ${wakeTime} (10 min before class).`);

      const timer = setTimeout(() => {
        startPollingForClass(classInfo, endMs);
      }, delayMs);
      scheduledTimers.push(timer);

    } else if (now < endMs) {
      // Within 10-min window or class already started — start polling now
      bot.log(`⚡ "${classInfo.name}" is within 10-min window — starting polling now.`);
      startPollingForClass(classInfo, endMs);
    }
  });
}

/**
 * Helper — find the next class in the daily timetable that starts at or after `afterMs`
 */
function getNextClass(afterMs) {
  const upcoming = bot.dailyTimetable
    .map(c => ({
      c,
      startMs: bot.parseSingleTime(c.time.split(/[-]|to/i)[0]),
      endMs:   bot.parseEndTime(c.time)
    }))
    .filter(({ startMs, endMs }) => startMs && endMs && endMs > afterMs)
    .sort((a, b) => a.startMs - b.startMs);
  return upcoming.length > 0 ? upcoming[0] : null;
}

/**
 * Chain to the next class after the current one ends.
 * Called 30 s before the current class end.
 */
async function chainToNextClass(currentClass) {
  bot.log(`🔄 Leaving "${currentClass.name}" 30 s early to prepare for next class.`);

  // Close (leave) current class
  await bot.closeBrowser();
  bot.status = 'sleeping';

  // Find next class whose end is after right now
  const now = Date.now();
  const next = getNextClass(now);

  if (!next) {
    bot.log('📴 No more classes today after this one. All done! See you tomorrow!');
    bot.status = 'done_for_day';
    return;
  }

  const { c: nextClass, startMs, endMs } = next;
  bot.log(`➡️  Next class: "${nextClass.name}" (${nextClass.time}). Starting pre-class polling now.`);

  // If next class starts more than 10 min from now, wait until 10 min before it
  const wakeMs  = startMs - 10 * 60 * 1000;
  const delayMs = wakeMs - Date.now();

  if (delayMs > 0) {
    const wakeTime = new Date(wakeMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    bot.log(`⏰ Sleeping until ${wakeTime} (10 min before "${nextClass.name}").`);
    const timer = setTimeout(() => startPollingForClass(nextClass, endMs), delayMs);
    scheduledTimers.push(timer);
  } else {
    // Already within 10-min window or class already started
    startPollingForClass(nextClass, endMs);
  }
}

/**
 * STEP 3 — Poll every 5 minutes until class is joined or ends
 */
function startPollingForClass(classInfo, endMs) {
  if (!botEnabled) return;

  bot.log(`🔔 Waking up for "${classInfo.name}" — polling every 5 minutes...`);

  // Clear any existing interval
  if (activePollingInterval) {
    clearInterval(activePollingInterval);
    activePollingInterval = null;
  }

  // Try immediately first, then every 5 minutes
  tryJoinClass(classInfo, endMs);

  activePollingInterval = setInterval(() => {
    tryJoinClass(classInfo, endMs);
  }, 5 * 60 * 1000); // every 5 minutes
}

/**
 * STEP 4 — Single join attempt
 * On success: stop polling, schedule "leave 30 s before end" timer, then chain to next class.
 * On class ended: stop polling, chain to next class.
 */
async function tryJoinClass(classInfo, endMs) {
  if (!botEnabled) return;

  const now = Date.now();

  // Class has ended (past end time)
  if (now >= endMs) {
    bot.log(`🎓 "${classInfo.name}" has ended.`);
    clearInterval(activePollingInterval);
    activePollingInterval = null;
    await chainToNextClass(classInfo);
    return;
  }

  // Already joined this class — just wait
  if (bot.status === 'joined') {
    bot.log(`✅ Still in class "${classInfo.name}". Waiting for it to end...`);
    return;
  }

  bot.log(`🔍 Checking if "${classInfo.name}" has started...`);

  let result;
  try {
    result = await bot.checkAndJoin(credentials.regNumber, credentials.password);
  } catch (e) {
    bot.log(`Error during join attempt: ${e.message}`, 'error');
    return;
  }

  if (result.joined === true) {
    bot.log(`✅ Joined "${classInfo.name}"! Stopping poll.`);

    // Stop the 5-min polling
    clearInterval(activePollingInterval);
    activePollingInterval = null;

    // Schedule exit 30 s before end, then chain to next class
    const LEAVE_EARLY_MS = 30 * 1000; // 30 seconds
    const msUntilLeave   = endMs - Date.now() - LEAVE_EARLY_MS;

    if (msUntilLeave > 0) {
      const leaveTime = new Date(endMs - LEAVE_EARLY_MS)
        .toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      bot.log(`⏳ Will leave "${classInfo.name}" at ${leaveTime} (30 s before end) and join the next class.`);

      const leaveTimer = setTimeout(async () => {
        await chainToNextClass(classInfo);
      }, msUntilLeave);
      scheduledTimers.push(leaveTimer);

    } else {
      // Less than 30 s left — leave and chain immediately
      bot.log(`⚡ Less than 30 s left in "${classInfo.name}" — leaving and chaining immediately.`);
      await chainToNextClass(classInfo);
    }

  } else if (result.status === 'too_early' || result.action === 'no_active_class_yet') {
    const minsLeft = Math.round((endMs - Date.now()) / 60000);
    bot.log(`⏳ "${classInfo.name}" not started yet. Retrying in 5 min (${minsLeft} min until end).`);

  } else {
    bot.log(`⚠️ Join attempt result: ${JSON.stringify(result)}`, 'warn');
  }
}

// ─────────────────────────────────────────────
// CRON — 8 AM DAILY (Mon–Sat)
// ─────────────────────────────────────────────
cron.schedule('0 8 * * 1-6', async () => {
  bot.log('🕗 8 AM cron fired — starting morning sync...');
  await doMorningSyncAndSchedule();
}, { timezone: 'Asia/Kolkata' });

bot.log('📅 Cron scheduled: Morning sync at 8 AM (Mon–Sat, IST).');

// ─────────────────────────────────────────────
// SELF-PING (keeps Render free tier alive)
// ─────────────────────────────────────────────
function startSelfPing() {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
  if (RENDER_URL) {
    setInterval(async () => {
      try { await fetch(`${RENDER_URL}/health`); } catch {}
    }, 14 * 60 * 1000);
    bot.log('Self-ping enabled to prevent Render spin-down.');
  } else {
    bot.log('Running locally — self-ping not needed.');
  }
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 AutoClassJoiner running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}\n`);

  bot.log(`Server started on port ${PORT}`);

  if (!credentials.regNumber || !credentials.password) {
    bot.log('⚠️ No credentials in env vars. Set REG_NUMBER and PASSWORD.');
  } else {
    // On startup: check if we're within the active day window
    const now = new Date();
    const hour = parseInt(new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false
    }).format(now));

    if (hour >= 8 && hour < 22) {
      // Within active hours — if we haven't synced today, do it now
      const today = now.toDateString();
      if (bot.lastDailySync !== today) {
        bot.log('🚀 Server started during active hours — running immediate morning sync...');
        await doMorningSyncAndSchedule();
      } else {
        bot.log('✅ Timetable already synced today. Scheduling from existing data...');
        schedulePreClassTimers(bot.dailyTimetable);
      }
    } else {
      bot.log('💤 Server started outside active hours (before 8 AM or after 10 PM). Waiting for 8 AM cron.');
      bot.status = 'sleeping';
    }
  }

  startSelfPing();
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────
process.on('SIGTERM', async () => {
  bot.log('Shutting down...');
  cancelAll();
  await bot.closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  bot.log('Shutting down (SIGINT)...');
  cancelAll();
  await bot.closeBrowser();
  process.exit(0);
});

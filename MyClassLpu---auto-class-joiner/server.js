/**
 * AutoClassJoiner - Cloud Server
 * Express server + Cron scheduler for Render deployment.
 */

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const AutoClassBot = require('./bot');

const app = express();
const bot = new AutoClassBot();
const PORT = process.env.PORT || 3000;

// Credentials from environment variables (or set via dashboard)
let credentials = {
  regNumber: process.env.REG_NUMBER || '',
  password: process.env.PASSWORD || ''
};

let cronJob = null;
let botEnabled = true;

// BUG 2 FIX: array to track all pending setTimeout timers for scheduled joins
let scheduledTimers = [];

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== API Routes ==========

// Dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get bot status
app.get('/api/status', (req, res) => {
  const status = bot.getStatus();
  res.json({
    ...status,
    botEnabled,
    hasCredentials: !!(credentials.regNumber && credentials.password),
    regNumber: credentials.regNumber,
    cronRunning: cronJob !== null
  });
});

// Update credentials
app.post('/api/credentials', (req, res) => {
  const { regNumber, password } = req.body;

  if (!regNumber || !password) {
    return res.status(400).json({ error: 'Both registration number and password are required.' });
  }

  credentials.regNumber = regNumber;
  credentials.password = password;

  bot.log(`Credentials updated for ${regNumber.substring(0, 4)}****`);

  // Restart cron if enabled
  if (botEnabled) {
    startCronJob();
  }

  res.json({ success: true, message: 'Credentials saved.' });
});

// Toggle bot on/off
app.post('/api/toggle', (req, res) => {
  botEnabled = !botEnabled;

  if (botEnabled) {
    startCronJob();
    bot.log('Bot ENABLED.');
  } else {
    stopCronJob();
    cancelScheduledTimers();
    bot.log('Bot DISABLED.');
  }

  res.json({ success: true, enabled: botEnabled });
});

// Manually trigger a check
app.post('/api/trigger', async (req, res) => {
  if (!credentials.regNumber || !credentials.password) {
    return res.status(400).json({ error: 'No credentials set.' });
  }

  bot.log('⚡ Manual check triggered from dashboard. Bypassing sleep timer...');
  const result = await bot.checkAndJoin(credentials.regNumber, credentials.password, true); // true = forceScan
  res.json(result);
});

// Send Test Email
app.post('/api/test-email', async (req, res) => {
  bot.log('🧪 Sending a test email...');
  try {
    await bot.sendNotificationEmail('Test Class', '12:00 PM', 'TEST');
    res.json({ success: true, message: 'Test email sent. Check your inbox (and spam).' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get timetable
app.get('/api/schedule', (req, res) => {
  res.json({ timetable: bot.timetable });
});

// Get latest screenshot (base64 JSON — used as fallback)
app.get('/api/screenshot', async (req, res) => {
  const screenshot = await bot.takeScreenshot();
  if (screenshot) {
    res.json({ image: screenshot, url: bot.getCurrentUrl() });
  } else {
    res.json({ image: null, url: null, message: 'No browser session active' });
  }
});

// ── MJPEG Live Stream ──────────────────────────────────────────────────────
// Streams Puppeteer screenshots as a continuous MJPEG feed (~1.5 fps).
// The browser uses a plain <img src="/api/stream"> — no JS, no WebSocket.
const STREAM_FPS_MS = 1000; // ms between frames (~1.0 fps) for stability
const activeStreamClients = new Set();

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=mjpegframe',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'X-Accel-Buffering': 'no', // Disable Nginx/proxy buffering
  });

  let alive = true;
  activeStreamClients.add(res);
  bot.log(`MJPEG stream client connected (${activeStreamClients.size} active).`, 'info');

  // Write a placeholder frame immediately so the browser shows something
  const writePlaceholder = () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">` +
      `<rect width="1280" height="720" fill="#1a1a1a"/>` +
      `<text x="50%" y="50%" fill="#555" font-family="monospace" font-size="22" ` +
      `text-anchor="middle" dominant-baseline="middle">No browser session active</text></svg>`
    );
    writeFrame(svg, 'image/svg+xml');
  };

  const writeFrame = (buffer, mime = 'image/jpeg') => {
    if (!alive || res.destroyed) return false;
    try {
      // Use standard MJPEG frame structure with trailing newlines
      res.write(`--mjpegframe\r\nContent-Type: ${mime}\r\nContent-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write('\r\n\r\n');
      return true;
    } catch {
      return false;
    }
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
      } catch {
        writePlaceholder();
      }
      // Wait for next frame
      await new Promise(r => setTimeout(r, STREAM_FPS_MS));
    }
    cleanup();
  };

  const cleanup = () => {
    alive = false;
    activeStreamClients.delete(res);
    try { res.end(); } catch {}
    bot.log(`MJPEG stream client disconnected (${activeStreamClients.size} remaining).`, 'info');
  };

  req.on('close', () => { alive = false; });
  req.on('error', () => { alive = false; });

  streamLoop();
});

// How many clients are currently streaming
app.get('/api/stream/status', (req, res) => {
  res.json({ clients: activeStreamClients.size });
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ========== Cron Scheduler ==========

function startCronJob() {
  stopCronJob();

  if (!credentials.regNumber || !credentials.password) {
    bot.log('Cannot start cron — no credentials set.', 'warn');
    return;
  }

  // BUG 2 FIX: Run every 30 minutes (instead of every 2 min) to refresh timetable.
  // Precise join scheduling is now handled by scheduleUpcomingClasses() via setTimeout.
  cronJob = cron.schedule('*/30 8-22 * * 1-6', async () => {
    bot.log('🔄 30-min cron: refreshing timetable and rescheduling...');
    const result = await bot.checkAndJoin(credentials.regNumber, credentials.password);
    // After each timetable refresh, reschedule upcoming classes
    if (bot.dailyTimetable && bot.dailyTimetable.length > 0) {
      scheduleUpcomingClasses(bot.dailyTimetable);
    }
    return result;
  }, {
    timezone: 'Asia/Kolkata'
  });

  bot.log('Cron job started — refreshing timetable every 30 min (Mon-Sat, 8AM-10PM IST).');
}

function stopCronJob() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    bot.log('Cron job stopped.');
  }
}

// ========== BUG 2 FIX: Smart Class Scheduling ==========

/**
 * Cancel all pending scheduled join timers.
 */
function cancelScheduledTimers() {
  if (scheduledTimers.length > 0) {
    scheduledTimers.forEach(t => clearTimeout(t));
    bot.log(`🗑️ Cancelled ${scheduledTimers.length} pending scheduled join timer(s).`);
    scheduledTimers = [];
  }
}

/**
 * scheduleUpcomingClasses(classes)
 * For each class that has not ended and is not already ongoing, schedules a
 * join attempt 5 minutes before its start time (if within the next 4 hours).
 */
function scheduleUpcomingClasses(classes) {
  if (!botEnabled || !credentials.regNumber || !credentials.password) return;

  // Cancel any previously scheduled timers first
  cancelScheduledTimers();

  const now = Date.now();
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const FIVE_MIN_MS = 5 * 60 * 1000;

  classes.forEach(classInfo => {
    const startMs = bot.parseSingleTime(classInfo.time.split(/[-]|to/i)[0]);
    const endMs = bot.parseEndTime(classInfo.time);

    // Skip classes that have already ended
    if (!startMs || (endMs && now >= endMs)) return;

    // Skip classes already ongoing (they will be joined in the current check cycle)
    if (classInfo.status === 'ongoing') return;

    // Calculate delay to 5 minutes before start
    const delay = (startMs - FIVE_MIN_MS) - now;

    if (delay > 0 && delay < FOUR_HOURS_MS) {
      const delayMin = Math.round(delay / 60000);
      bot.log(`📅 Scheduling join attempt for "${classInfo.name}" in ${delayMin} min(s).`);
      const timer = setTimeout(() => {
        retryJoinUntilSuccess(classInfo);
      }, delay);
      scheduledTimers.push(timer);
    } else if (delay <= 0) {
      bot.log(`⏭️ "${classInfo.name}" is imminent or already past — skipping scheduler (will join via active check).`);
    } else {
      bot.log(`⏭️ "${classInfo.name}" starts in more than 4 hours — skipping scheduler for now.`);
    }
  });
}

/**
 * retryJoinUntilSuccess(classInfo, retryCount)
 * Calls bot.checkAndJoin and retries every 45 seconds if too early,
 * stops on success, error, or after 20 attempts.
 */
async function retryJoinUntilSuccess(classInfo, retryCount = 0) {
  const MAX_RETRIES = 20;

  if (!botEnabled) {
    bot.log(`🚫 Bot disabled — aborting retry for "${classInfo.name}".`);
    return;
  }

  if (!credentials.regNumber || !credentials.password) {
    bot.log('🚫 No credentials — aborting retry.', 'warn');
    return;
  }

  // Check if class end time has already passed
  const endMs = bot.parseEndTime(classInfo.time);
  if (endMs && Date.now() >= endMs) {
    bot.log(`⏰ "${classInfo.name}" has ended — stopping retries.`);
    return;
  }

  if (retryCount >= MAX_RETRIES) {
    bot.log(`🛑 Max retries (${MAX_RETRIES}) reached for "${classInfo.name}" — giving up.`, 'warn');
    return;
  }

  bot.log(`🔁 Retry attempt ${retryCount + 1}/${MAX_RETRIES} for "${classInfo.name}"...`);
  let result;
  try {
    result = await bot.checkAndJoin(credentials.regNumber, credentials.password);
    // Re-schedule upcoming classes after every timetable refresh
    if (bot.dailyTimetable && bot.dailyTimetable.length > 0) {
      scheduleUpcomingClasses(bot.dailyTimetable);
    }
  } catch (e) {
    bot.log(`Error during retry for "${classInfo.name}": ${e.message}`, 'error');
    result = { joined: false, status: 'error' };
  }

  if (result.joined === true) {
    bot.log(`✅ Successfully joined "${classInfo.name}" on retry ${retryCount + 1}.`);
    return;
  }

  if (result.status === 'error') {
    bot.log(`❌ Error joining "${classInfo.name}" — stopping retries.`, 'error');
    return;
  }

  if (result.status === 'too_early' || result.action === 'no_active_class_yet') {
    bot.log(`⏳ Too early for "${classInfo.name}" — retrying in 45 seconds (attempt ${retryCount + 1}).`);
    const timer = setTimeout(() => {
      retryJoinUntilSuccess(classInfo, retryCount + 1);
    }, 45 * 1000);
    scheduledTimers.push(timer);
  }
  // All other outcomes (sleep, finished, no_classes, skip) — stop retrying
}

// ========== Self-Ping (Keep Alive on Render Free Tier) ==========

function startSelfPing() {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

  if (RENDER_URL) {
    setInterval(async () => {
      try {
        await fetch(`${RENDER_URL}/health`);
      } catch {}
    }, 14 * 60 * 1000); // Every 14 minutes

    bot.log('Self-ping enabled to prevent Render spin-down.');
  } else {
    bot.log('Running locally — self-ping not needed.', 'info');
  }
}

// ========== Start Server ==========

app.listen(PORT, async () => {
  console.log(`\n🚀 AutoClassJoiner Cloud Bot running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}\n`);

  bot.log(`Server started on port ${PORT}`);

  // Start cron if credentials are available
  if (credentials.regNumber && credentials.password) {
    startCronJob();

    // BUG 2 FIX: Run an immediate timetable scrape on startup, then schedule classes
    bot.log('🚀 Startup: Running initial timetable sync...');
    try {
      await bot.checkAndJoin(credentials.regNumber, credentials.password);
      if (bot.dailyTimetable && bot.dailyTimetable.length > 0) {
        scheduleUpcomingClasses(bot.dailyTimetable);
      }
    } catch (e) {
      bot.log(`Startup sync failed: ${e.message}`, 'error');
    }
  } else {
    bot.log('No credentials in env vars. Set them via the dashboard or env: REG_NUMBER, PASSWORD');
  }

  // Start self-ping for Render
  startSelfPing();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  bot.log('Shutting down...');
  stopCronJob();
  cancelScheduledTimers();
  await bot.closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  bot.log('Shutting down (SIGINT)...');
  stopCronJob();
  cancelScheduledTimers();
  await bot.closeBrowser();
  process.exit(0);
});

/**
 * AutoClassJoiner - Advanced Cloud Bot (Puppeteer)
 * Features: Smart Scheduling, Email Notifications, Headless Automation
 */

const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');

const LOGIN_URL = 'https://myclass.lpu.in';
const BASE_URL = 'https://lovelyprofessionaluniversity.codetantra.com';
const TIMETABLE_URL = `${BASE_URL}/secure/tla/m.jsp`;

class AutoClassBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.logs = [];
    this.lastCheck = null;
    this.lastJoined = null;
    this.timetable = [];
    this.dailyTimetable = [];
    this.lastDailySync = null;
    this.status = 'idle';
    this.latestScreenshot = null;
    this.latestScreenshotUrl = null;
    this.activeClassEndTime = null;
    this.noClassesFoundToday = false;
    this.totalActiveMinutes = 0;
    this.lastActiveMinuteUpdate = Date.now();


    // Email Config from Env
    this.emailConfig = {
      recipient: process.env.NOTIFICATION_EMAIL || '',
      sender: process.env.SENDER_EMAIL || '',
      pass: process.env.SENDER_PASS || ''
    };
  }

  log(message, level = 'info') {
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const entry = { timestamp, level, message };
    this.logs.push(entry);
    if (this.logs.length > 100) this.logs.shift();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);

    if (this.page && !this.page.isClosed()) {
      this.page.screenshot({ encoding: 'base64', type: 'webp', quality: 40 })
        .then(b64 => {
          this.latestScreenshot = b64;
          this.latestScreenshotUrl = this.page.url();
        })
        .catch(() => { });
    }
  }

  /**
   * Send Email Notification
   */
  async sendNotificationEmail(className, time, action = 'JOINED') {
    if (!this.emailConfig.recipient || !this.emailConfig.sender || !this.emailConfig.pass) {
      this.log('Email notifications skipped: Credentials missing in env vars.', 'warn');
      return;
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: this.emailConfig.sender, pass: this.emailConfig.pass }
    });

    const mailOptions = {
      from: `"AutoClass Bot" <${this.emailConfig.sender}>`,
      to: this.emailConfig.recipient,
      subject: `🎓 Class ${action}: ${className}`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
          <h2 style="color: #2e7d32;">Class ${action === 'JOINED' ? 'Joined Successfully ✅' : 'Update'}</h2>
          <p><strong>Class:</strong> ${className}</p>
          <p><strong>Time:</strong> ${time}</p>
          <p><strong>Status:</strong> The bot is currently in the session and "listening."</p>
          <hr/>
          <p style="font-size: 12px; color: #888;">Live status available on your Render Dashboard.</p>
        </div>
      `
    };

    try {
      await transporter.sendMail(mailOptions);
      this.log(`📧 Notification email sent to ${this.emailConfig.recipient}`);
    } catch (error) {
      this.log(`Failed to send email: ${error.message}`, 'error');
    }
  }

  async launchBrowser() {
    if (this.browser) {
      try {
        await this.browser.version();
        return;
      } catch {
        this.browser = null;
        this.page = null;
      }
    }

    this.log('Launching browser...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'],
      defaultViewport: { width: 1280, height: 720 }
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  }

  async login(regNumber, password) {
    try {
      await this.launchBrowser();
      this.status = 'logging_in';
      this.log(`Logging in as ${regNumber}...`);
      await this.page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      const userField = await this.page.waitForSelector('input[aria-label="user name"], input[placeholder="Username"]', { timeout: 10000 });
      const passField = await this.page.$('#pwd-field') || await this.page.$('input[type="password"]');

      if (!userField || !passField) throw new Error('Login fields not found');

      await userField.type(regNumber, { delay: 50 });
      await passField.type(password, { delay: 50 });

      await this.page.keyboard.press('Enter');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });

      if (this.page.url().includes('codetantra.com')) {
        this.isLoggedIn = true;
        this.status = 'logged_in';
        return true;
      }
      return false;
    } catch (e) {
      this.log(`Login failed: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * SMART CHECK & JOIN
   * @param {boolean} forceScan - If true, ignores the 30-min sleep logic and performs a live check.
   */
  async checkAndJoin(regNumber, password, forceScan = false) {
    const now = Date.now();
    const today = new Date().toDateString();

    try {
      this.lastCheck = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      // 0. Skip if we already checked today and found nothing
      if (this.lastDailySync === today && this.noClassesFoundToday && !forceScan) {
        this.status = 'no_classes_today';
        return { joined: false, action: 'skip_no_classes' };
      }

      this.log(forceScan ? '⚡ Manual check triggered...' : '⏰ Scheduled check triggered.');


      if (this.lastDailySync !== today || forceScan) {
        this.log(forceScan ? '⚡ Manual Force Action: Performing live login and sync...' : '🌅 Morning Sync: Scraping today\'s full schedule...');
        const loggedIn = await this.login(regNumber, password);
        if (loggedIn) {
          await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2' });
          await this.switchToListView();
          this.dailyTimetable = await this.scrapeClasses();
          this.noClassesFoundToday = (this.dailyTimetable.length === 0);
          this.lastDailySync = today;
          this.log(`Sync complete. Found ${this.dailyTimetable.length} classes.`);
        }
      }

      // 2. Are we already in a class?
      if (this.status === 'joined' && this.activeClassEndTime) {
        if (now < this.activeClassEndTime && !forceScan) {
          this.log(`In class: ${this.lastJoined.name}. Skipping check.`);
          return { joined: true, action: 'skip' };
        }
        if (!forceScan) {
          this.status = 'idle';
          this.activeClassEndTime = null;
        }
      }

      // 3. SMART SLEEP LOGIC (Bypassed if forceScan is true)
      const upcomingClasses = this.dailyTimetable.filter(c => {
        const startTime = this.parseSingleTime(c.time.split(/[-]|to/i)[0]);
        const endTime = this.parseEndTime(c.time);
        return startTime && endTime && now < endTime;
      });

      if (upcomingClasses.length > 0) {
        const nextClass = upcomingClasses[0];
        const startTime = this.parseSingleTime(nextClass.time.split(/[-]|to/i)[0]);
        const minutesToStart = Math.round((startTime - now) / 60000);

        if (minutesToStart > 30 && !forceScan) {
          this.log(`💤 Smart Sleep: Next class "${nextClass.name}" starts in ${minutesToStart} mins. Closing browser.`);
          this.status = 'sleeping';
          await this.closeBrowser();
          return { joined: false, action: 'sleep', nextIn: minutesToStart };
        }
      } else if (this.dailyTimetable.length > 0 && !forceScan) {
        this.log('📴 No more classes today. Closing browser. See you tomorrow!');
        this.status = 'done_for_day';
        await this.closeBrowser();
        return { joined: false, action: 'finished' };
      } else if (this.dailyTimetable.length === 0 && !forceScan) {
        this.log('🛌 No classes scheduled for today. Closing browser.');
        this.status = 'no_classes_today';
        await this.closeBrowser();
        return { joined: false, action: 'no_classes' };
      }

      // 4. Time to work! (Within 30 mins or Ongoing)
      this.log('⏰ Class approaching or ongoing. Active check starting...');
      if (!this.isLoggedIn) await this.login(regNumber, password);

      await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2' });
      await this.switchToListView();
      const currentClasses = await this.scrapeClasses();
      this.timetable = currentClasses;

      // BUG 1 FIX (step 3): Apply time-based override to ALL classes regardless of scraped status
      // This ensures classes marked "unknown" by the CSS-color scraper still get detected as ongoing
      currentClasses.forEach(c => {
        const times = c.time.split(/[-]|to/i).map(t => this.parseSingleTime(t));
        // Mark as ongoing if within 15 mins before start OR within end time
        if (times[0] && times[1] && now >= (times[0] - 15 * 60000) && now < times[1]) {
          if (c.status !== 'ongoing') {
            this.log(`⏱️ Time-override: marking "${c.name}" as ongoing (was: ${c.status})`);
          }
          c.status = 'ongoing';
        }
      });

      const ongoing = currentClasses.find(c => c.status === 'ongoing');
      if (ongoing) {
        if (!ongoing.meetingId) ongoing.meetingId = await this.clickAndExtractMeetingId(currentClasses.indexOf(ongoing));

        if (ongoing.meetingId) {
          const joined = await this.joinClass(ongoing);
          if (joined === true) {
            this.status = 'joined';
            this.lastJoined = { name: ongoing.name, time: ongoing.time };
            this.activeClassEndTime = this.parseEndTime(ongoing.time);
            await this.sendNotificationEmail(ongoing.name, ongoing.time, 'JOINED');
            return { joined: true, name: ongoing.name };
          }
        }
      }

      this.status = 'waiting';
      await this.closeBrowser(); // Ensure browser turns OFF after checks
      this.updateActiveTime(); // Track activity
      return { joined: false, action: 'no_active_class_yet', status: 'too_early' };

    } catch (e) {
      this.log(`Error: ${e.message}`, 'error');
      if (e.message.includes('Target closed') || e.message.includes('Session closed')) {
        this.isLoggedIn = false;
        this.browser = null;
        this.page = null;
      }
      return { joined: false, error: e.message, status: 'error' };
    }
  }

  async switchToListView() {
    await this.page.evaluate(() => {
      const btn = document.querySelector('.fc-listView-button') || document.querySelector('button[title="list view"]');
      if (btn) btn.click();
    });
    await this.delay(2000);
  }

  /**
   * scrapeClasses — improved version
   * BUG 1 FIX (steps 1 & 2):
   *   - If any cell in the row contains "Join" or "Join Now" text → status = 'ongoing'
   *   - If any <a href> in the row contains "jnr.jsp" → status = 'ongoing', extract meetingId from that href
   *   - Falls back to original CSS-color dot detection last (was unreliable)
   */
  async scrapeClasses() {
    return await this.page.evaluate(() => {
      const results = [];
      document.querySelectorAll('tr.fc-list-item').forEach(row => {
        const time = row.querySelector('.fc-list-item-time')?.textContent.trim() || '';
        const name = row.querySelector('.fc-list-item-title')?.textContent.trim() || '';

        // ── Detect meetingId from standard m= param link ──────────────────
        const mLink = row.querySelector('a[href*="m="]');
        let meetingId = mLink ? new URLSearchParams(mLink.href.split('?')[1]).get('m') : '';

        // ── BUG 1 FIX step 2: detect direct join link (jnr.jsp) ──────────
        const jnrLink = row.querySelector('a[href*="jnr.jsp"]');
        let status = 'scheduled';
        if (jnrLink) {
          status = 'ongoing';
          // Extract meetingId from jnr.jsp?m=XXXX
          const jnrParams = new URLSearchParams(jnrLink.href.split('?')[1] || '');
          if (jnrParams.get('m')) meetingId = jnrParams.get('m');
        }

        // ── BUG 1 FIX step 1: detect "Join" / "Join Now" button text ─────
        if (status !== 'ongoing') {
          const allText = row.innerText || '';
          const joinMatch = allText.match(/\bJoin(\s+Now)?\b/i);
          if (joinMatch) {
            status = 'ongoing';
          }
        }

        // ── Original CSS-color dot fallback (kept for extra signal) ───────
        if (status !== 'ongoing') {
          const dot = row.querySelector('.fc-list-item-marker span');
          if (dot) {
            const bg = window.getComputedStyle(dot).backgroundColor;
            // Green shades used by CodeTantra for live/ongoing classes
            if (bg && (bg.includes('0, 128') || bg.includes('0, 200') || bg.includes('34, 139'))) {
              status = 'ongoing';
            } else if (bg) {
              status = 'upcoming';
            }
          }
        }

        results.push({ name, time, meetingId, status });
      });
      return results;
    });
  }

  /**
   * clickAndExtractMeetingId — improved version
   * BUG 1 FIX (step 4):
   *   - After clicking and waiting 2s, search ALL iframes for jnr.jsp or mi.jsp links
   *   - Navigate back to TIMETABLE_URL before returning so subsequent calls work
   */
  async clickAndExtractMeetingId(idx) {
    if (!this.page || this.page.isClosed()) return null;

    // Click the row to open detail panel/modal
    await this.page.evaluate((i) => {
      const rows = document.querySelectorAll('tr.fc-list-item');
      if (rows[i]) rows[i].click();
    }, idx);
    await this.delay(2000);

    // First try: find meetingId in the main document
    let meetingId = await this.page.evaluate(() => {
      // Look for jnr.jsp link (direct join) first
      const jnr = document.querySelector('a[href*="jnr.jsp"]');
      if (jnr) {
        const p = new URLSearchParams(jnr.href.split('?')[1] || '');
        if (p.get('m')) return p.get('m');
      }
      // Fallback: standard m= param link
      const a = document.querySelector('a[href*="m="]');
      return a ? new URLSearchParams(a.href.split('?')[1]).get('m') : null;
    });

    // BUG 1 FIX step 4: if not found in main doc, search all iframes
    if (!meetingId) {
      this.log('Meeting ID not found in main document — searching iframes...');
      try {
        const frames = this.page.frames();
        for (const frame of frames) {
          try {
            const id = await frame.evaluate(() => {
              // Check for jnr.jsp or mi.jsp links inside this frame
              const jnr = document.querySelector('a[href*="jnr.jsp"]');
              if (jnr) {
                const p = new URLSearchParams(jnr.href.split('?')[1] || '');
                if (p.get('m')) return p.get('m');
              }
              const mi = document.querySelector('a[href*="mi.jsp"]');
              if (mi) {
                const p = new URLSearchParams(mi.href.split('?')[1] || '');
                if (p.get('m')) return p.get('m');
              }
              const a = document.querySelector('a[href*="m="]');
              return a ? new URLSearchParams(a.href.split('?')[1]).get('m') : null;
            });
            if (id) {
              meetingId = id;
              this.log(`Meeting ID found in iframe: ${id}`);
              break;
            }
          } catch { /* frame may be cross-origin, skip */ }
        }
      } catch (e) {
        this.log(`iframe search error: ${e.message}`, 'warn');
      }
    }

    // BUG 1 FIX step 4: navigate back to timetable so the page stays usable
    try {
      await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
      await this.switchToListView();
    } catch (e) {
      this.log(`Could not navigate back to timetable: ${e.message}`, 'warn');
    }

    return meetingId || null;
  }

  /**
   * joinClass — improved version
   * BUG 1 FIX (step 5):
   *   - After navigating to jnr.jsp, wait for BBB redirect OR "joining" body text
   *     using page.waitForFunction (30s timeout) instead of a blind delay(5000).
   *   - Keep all 4 retries for the Listen Only button with iframe search.
   */
  async joinClass(c) {
    const joinUrl = `${BASE_URL}/secure/tla/jnr.jsp?m=${c.meetingId}`;
    this.log(`🔗 Navigating to join URL: ${joinUrl}`);
    await this.page.goto(joinUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // BUG 1 FIX step 5: wait for BBB redirect or body text rather than fixed delay
    try {
      await this.page.waitForFunction(
        () => {
          // Condition 1: redirected to BigBlueButton
          if (window.location.href.includes('bigbluebutton')) return true;
          // Condition 2: page body says we are joining
          const body = document.body ? document.body.innerText.toLowerCase() : '';
          if (body.includes('you are joining') || body.includes('joining the session')) return true;
          // Condition 3: a Listen Only button has appeared (BBB client loaded)
          const listenBtn = Array.from(document.querySelectorAll('button')).find(
            b => b.innerText.toLowerCase().includes('listen only')
          );
          if (listenBtn) return true;
          return false;
        },
        { timeout: 30000, polling: 1000 }
      );
      this.log('✅ Join page confirmed — BBB session detected.');
    } catch {
      // If timeout, page may still have loaded — proceed anyway
      this.log('⚠️ Join confirmation timed out — attempting Listen Only anyway.', 'warn');
    }

    // Try clicking Listen Only button with 4 retries + iframe search (kept from original)
    for (let attempt = 1; attempt <= 4; attempt++) {
      // Search main document first
      const clicked = await this.page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(
          b => b.innerText.toLowerCase().includes('listen only')
        );
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (clicked) {
        this.log(`🎧 Listen Only clicked (attempt ${attempt}, main doc).`);
        return true;
      }

      // Search all iframes for Listen Only button
      let iframeClicked = false;
      try {
        const frames = this.page.frames();
        for (const frame of frames) {
          try {
            const result = await frame.evaluate(() => {
              const btn = Array.from(document.querySelectorAll('button')).find(
                b => b.innerText.toLowerCase().includes('listen only')
              );
              if (btn) { btn.click(); return true; }
              return false;
            });
            if (result) {
              this.log(`🎧 Listen Only clicked (attempt ${attempt}, iframe).`);
              iframeClicked = true;
              break;
            }
          } catch { /* cross-origin frame — skip */ }
        }
      } catch { }

      if (iframeClicked) return true;

      this.log(`Listen Only not found yet (attempt ${attempt}/4). Waiting 3s...`);
      await this.delay(3000);
    }

    this.log('⚠️ Listen Only button not found after 4 attempts — returning true anyway.', 'warn');
    return true;
  }

  parseSingleTime(timeStr) {
    if (!timeStr) return null;
    try {
      const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (!match) return null;
      let hours = parseInt(match[1]);
      const mins = parseInt(match[2]);
      const ampm = match[3]?.toUpperCase();
      if (ampm === 'PM' && hours < 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;

      // ── IST FIX ──────────────────────────────────────────────────────────
      // The scraped times are always IST (Asia/Kolkata = UTC+5:30).
      // Build the epoch by anchoring to today's IST midnight so the result
      // is correct even when the server runs in UTC or any other timezone.
      const nowUtc = Date.now();
      // IST offset in ms (+5h 30m)
      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      // Today's date in IST
      const todayIst = new Date(nowUtc + IST_OFFSET_MS);
      // IST midnight for today (UTC epoch of 00:00 IST today)
      const istMidnightUtc = Date.UTC(
        todayIst.getUTCFullYear(),
        todayIst.getUTCMonth(),
        todayIst.getUTCDate()
      ) - IST_OFFSET_MS;
      // Class epoch = IST midnight + class hours/mins — interpreted as IST
      return istMidnightUtc + (hours * 60 + mins) * 60 * 1000;
    } catch { return null; }
  }

  parseEndTime(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(/[-]|to/i);
    return parts.length > 1 ? this.parseSingleTime(parts[1]) : null;
  }

  /**
   * Take a screenshot of the current page
   */
  async takeScreenshot() {
    if (this.page && !this.page.isClosed()) {
      try {
        const b64 = await this.page.screenshot({ encoding: 'base64', type: 'webp', quality: 50 });
        this.latestScreenshot = b64;
        this.latestScreenshotUrl = this.page.url();
        return b64;
      } catch (e) { return null; }
    }
    return null; // Return null if browser is off
  }

  /**
   * Get the current page URL
   */
  getCurrentUrl() {
    try {
      if (this.page && !this.page.isClosed()) {
        this.latestScreenshotUrl = this.page.url();
      }
    } catch { }
    return this.latestScreenshotUrl;
  }

  async closeBrowser() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.log('Browser closed successfully.');
      } catch (e) {
        this.log(`Error closing browser: ${e.message}`, 'error');
      } finally {
        this.browser = null;
        this.page = null;
        this.isLoggedIn = false;
        this.latestScreenshot = null;
        this.latestScreenshotUrl = null;
      }
    }
  }

  updateActiveTime() {
    const now = Date.now();
    const diff = now - this.lastActiveMinuteUpdate;
    if (diff >= 60000) {
      const mins = Math.floor(diff / 60000);
      this.totalActiveMinutes += mins;
      this.lastActiveMinuteUpdate = now - (diff % 60000);
    }
  }

  delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  getStatus() {
    this.updateActiveTime();
    return {
      status: this.status,
      isLoggedIn: this.isLoggedIn,
      lastCheck: this.lastCheck,
      lastJoined: this.lastJoined,
      timetable: this.dailyTimetable,
      logs: this.logs.slice(-20),
      uptime: process.uptime(),
      activeMinutes: this.totalActiveMinutes,
      currentUrl: this.getCurrentUrl(),
      screenshotAvailable: !!(this.latestScreenshot)
    };
  }
}

module.exports = AutoClassBot;

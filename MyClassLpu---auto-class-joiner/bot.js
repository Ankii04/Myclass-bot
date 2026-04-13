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

    // FIX: prevent concurrent checkAndJoin calls from racing
    this.isRunning = false;

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
        this.isLoggedIn = false;
      }
    }

    this.log('Launching browser...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ],
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

      // FIX: broader selector set + longer timeout (was 10s, now 15s)
      const userField = await this.page.waitForSelector(
        'input[aria-label="user name"], input[placeholder="Username"], input[name="i"]',
        { timeout: 15000 }
      );
      const passField =
        await this.page.$('#pwd-field') ||
        await this.page.$('input[aria-label="password"]') ||
        await this.page.$('input[placeholder="Password"]') ||
        await this.page.$('input[name="p"]') ||
        await this.page.$('input[type="password"]');

      if (!userField || !passField) throw new Error('Login fields not found');

      await userField.click({ clickCount: 3 });
      await userField.type(regNumber, { delay: 50 });
      await passField.click({ clickCount: 3 });
      await passField.type(password, { delay: 50 });

      // FIX: click Login button by text first, fallback to Enter
      let clicked = false;
      const buttons = await this.page.$$('button');
      for (const btn of buttons) {
        const text = await this.page.evaluate(el => el.textContent.trim().toLowerCase(), btn);
        if (text === 'login' || text === 'sign in') {
          await btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) await this.page.keyboard.press('Enter');

      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });

      // Extra wait for redirect chain
      await this.delay(3000);
      const finalUrl = this.page.url();

      if (finalUrl.includes('codetantra.com') || finalUrl.includes('/secure/')) {
        this.isLoggedIn = true;
        this.status = 'logged_in';
        this.log('Login successful!');
        return true;
      }

      this.log(`Login status unclear. URL: ${finalUrl}`, 'warn');
      return false;
    } catch (e) {
      this.log(`Login failed: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * SMART CHECK & JOIN
   * FIX: isRunning guard prevents two concurrent calls from racing (which crashes login)
   */
  async checkAndJoin(regNumber, password, forceScan = false) {
    // FIX: guard against concurrent execution
    if (this.isRunning && !forceScan) {
      this.log('⚠️ Already running a check — skipping this trigger.', 'warn');
      return { joined: false, action: 'busy' };
    }
    this.isRunning = true;

    const now = Date.now();
    const today = new Date().toDateString();

    try {
      this.lastCheck = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      if (this.lastDailySync === today && this.noClassesFoundToday && !forceScan) {
        this.status = 'no_classes_today';
        this.isRunning = false;
        return { joined: false, action: 'skip_no_classes' };
      }

      this.log(forceScan ? '⚡ Manual check triggered...' : '⏰ Scheduled check triggered.');

      if (this.lastDailySync !== today || forceScan) {
        this.log(forceScan
          ? '⚡ Manual Force Action: Performing live login and sync...'
          : '🌅 Morning Sync: Scraping today\'s full schedule...');
        const loggedIn = await this.login(regNumber, password);
        if (loggedIn) {
          await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
          await this.switchToListView();
          this.dailyTimetable = await this.scrapeClasses();
          this.noClassesFoundToday = (this.dailyTimetable.length === 0);
          this.lastDailySync = today;
          this.log(`Sync complete. Found ${this.dailyTimetable.length} classes.`);
        }
      }

      if (this.status === 'joined' && this.activeClassEndTime) {
        if (now < this.activeClassEndTime && !forceScan) {
          this.log(`In class: ${this.lastJoined?.name}. Skipping check.`);
          this.isRunning = false;
          return { joined: true, action: 'skip' };
        }
        if (!forceScan) {
          this.status = 'idle';
          this.activeClassEndTime = null;
        }
      }

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
          this.isRunning = false;
          return { joined: false, action: 'sleep', nextIn: minutesToStart };
        }
      } else if (this.dailyTimetable.length > 0 && !forceScan) {
        this.log('📴 No more classes today. Closing browser. See you tomorrow!');
        this.status = 'done_for_day';
        await this.closeBrowser();
        this.isRunning = false;
        return { joined: false, action: 'finished' };
      } else if (this.dailyTimetable.length === 0 && !forceScan) {
        this.log('🛌 No classes scheduled for today. Closing browser.');
        this.status = 'no_classes_today';
        await this.closeBrowser();
        this.isRunning = false;
        return { joined: false, action: 'no_classes' };
      }

      this.log('⏰ Class approaching or ongoing. Active check starting...');
      if (!this.isLoggedIn) {
        const ok = await this.login(regNumber, password);
        if (!ok) {
          this.isRunning = false;
          return { joined: false, error: 'Login failed' };
        }
      }

      await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

      // FIX: detect & handle session expiry
      if (this.page.url().includes('myclass.lpu.in') || this.page.url().includes('login')) {
        this.log('Session expired — re-logging in...', 'warn');
        this.isLoggedIn = false;
        const ok = await this.login(regNumber, password);
        if (!ok) {
          this.isRunning = false;
          return { joined: false, error: 'Re-login failed' };
        }
        await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
      }

      await this.switchToListView();
      const currentClasses = await this.scrapeClasses();
      this.timetable = currentClasses;

      // Time-based status override (15 min before start → end)
      currentClasses.forEach(c => {
        const times = c.time.split(/[-]|to/i).map(t => this.parseSingleTime(t));
        if (times[0] && times[1] && now >= (times[0] - 15 * 60000) && now < times[1]) {
          if (c.status !== 'ongoing') {
            this.log(`⏱️ Time-override: marking "${c.name}" as ongoing (was: ${c.status})`);
          }
          c.status = 'ongoing';
        }
      });

      const ongoing = currentClasses.find(c => c.status === 'ongoing');
      if (ongoing) {
        if (!ongoing.meetingId) {
          ongoing.meetingId = await this.clickAndExtractMeetingId(currentClasses.indexOf(ongoing));
        }

        if (ongoing.meetingId) {
          const joined = await this.joinClass(ongoing);
          if (joined === true) {
            this.status = 'joined';
            this.lastJoined = { name: ongoing.name, time: ongoing.time };
            this.activeClassEndTime = this.parseEndTime(ongoing.time);
            await this.sendNotificationEmail(ongoing.name, ongoing.time, 'JOINED');
            this.isRunning = false;
            return { joined: true, name: ongoing.name };
          }
          if (joined === 'TOO_EARLY') {
            this.status = 'waiting';
            this.isRunning = false;
            return { joined: false, status: 'too_early', action: 'no_active_class_yet' };
          }
        } else {
          this.log('⚠️ Could not extract meetingId — cannot join.', 'warn');
        }
      }

      this.status = 'waiting';
      await this.closeBrowser();
      this.updateActiveTime();
      this.isRunning = false;
      return { joined: false, action: 'no_active_class_yet', status: 'too_early' };

    } catch (e) {
      this.log(`Error: ${e.message}`, 'error');
      if (e.message.includes('Target closed') || e.message.includes('Session closed') || e.message.includes('detached')) {
        this.isLoggedIn = false;
        this.browser = null;
        this.page = null;
      }
      this.isRunning = false;
      return { joined: false, error: e.message, status: 'error' };
    }
  }

  async switchToListView() {
    try {
      await this.page.evaluate(() => {
        const btn = document.querySelector('.fc-listView-button') ||
          document.querySelector('.fc-listWeek-button') ||
          document.querySelector('button[title="list view"]');
        if (btn && !btn.classList.contains('fc-state-active') && !btn.classList.contains('fc-button-active')) {
          btn.click();
        }
      });
      await this.delay(2000);
    } catch (e) {
      this.log(`Could not switch to list view: ${e.message}`, 'warn');
    }
  }

  /**
   * scrapeClasses — detects ongoing via jnr.jsp link, Join text, CSS color dot
   * FIX: added Method 2 from original repo — scan entire page for mi.jsp/jnr.jsp links
   */
  async scrapeClasses() {
    return await this.page.evaluate(() => {
      const results = [];

      const extractId = (str) => {
        if (!str) return '';
        const m = str.match(/[?&]m=([a-f0-9-]+)/i);
        return m ? m[1] : '';
      };

      // Method 1: List view rows
      document.querySelectorAll('tr.fc-list-item, tr.fc-list-event').forEach(row => {
        const timeCell = row.querySelector('td.fc-list-item-time, td.fc-list-event-time');
        const titleCell = row.querySelector('td.fc-list-item-title, td.fc-list-event-title');
        const markerCell = row.querySelector('td.fc-list-item-marker, td.fc-list-event-dot-cell');

        if (!titleCell) return;

        const link = titleCell.querySelector('a');
        const time = timeCell ? timeCell.textContent.trim() : '';
        const name = link ? link.textContent.trim() : titleCell.textContent.trim();

        let meetingId = '';
        if (link) {
          meetingId = extractId(link.href) ||
            extractId(link.getAttribute('onclick') || '') ||
            link.getAttribute('data-meeting') || '';
        }
        if (!meetingId) {
          const anyLink = row.querySelector('[href*="mi.jsp"],[href*="jnr.jsp"],[onclick*="jnr.jsp"]');
          if (anyLink) meetingId = extractId(anyLink.href || '') || extractId(anyLink.getAttribute('onclick') || '');
        }
        if (!meetingId) {
          meetingId = row.getAttribute('data-id') || row.getAttribute('data-event-id') || '';
        }

        // Detect status: jnr.jsp link first
        const jnrLink = row.querySelector('a[href*="jnr.jsp"]');
        let status = 'scheduled';
        if (jnrLink) {
          status = 'ongoing';
          const p = new URLSearchParams(jnrLink.href.split('?')[1] || '');
          if (p.get('m')) meetingId = p.get('m');
        }

        // Detect via "Join" text
        if (status !== 'ongoing') {
          if (/\bJoin(\s+Now)?\b/i.test(row.innerText || '')) status = 'ongoing';
        }

        // Detect via CSS color dot
        if (status !== 'ongoing' && markerCell) {
          const dot = markerCell.querySelector('.fc-event-dot, .fc-list-event-dot') ||
            markerCell.querySelector('span');
          if (dot) {
            const bg = window.getComputedStyle(dot).backgroundColor;
            const match = bg && bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
              const [, r, g, b] = match.map(Number);
              if (g > 100 && g > r * 1.5 && g > b * 1.5) status = 'ongoing';
              else if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30 && r > 80 && r < 200) status = 'ended';
              else status = 'upcoming';
            }
          }
        }

        results.push({ name, time, meetingId, status });
      });

      // Method 2: Scan ENTIRE page for any mi.jsp or jnr.jsp links (original repo fallback)
      document.querySelectorAll('a[href*="mi.jsp"], a[href*="jnr.jsp"]').forEach(link => {
        const mId = extractId(link.href);
        if (!mId) return;
        const existing = results.find(c => c.meetingId === mId);
        if (!existing) {
          results.push({
            name: link.textContent.trim() || 'Live Class',
            time: '',
            meetingId: mId,
            status: link.href.includes('jnr.jsp') ? 'ongoing' : 'unknown'
          });
        } else if (link.href.includes('jnr.jsp')) {
          existing.status = 'ongoing';
        }
      });

      return results;
    });
  }

  /**
   * clickAndExtractMeetingId
   * FIX 1: wait 5s instead of 2s for popup to render
   * FIX 2: search popup/modal selectors (from original repo)
   * FIX 3: check URL after click for meetingId
   * FIX 4: navigate back safely — only if not already on timetable
   */
  async clickAndExtractMeetingId(idx) {
    if (!this.page || this.page.isClosed()) return null;

    await this.page.evaluate((i) => {
      const rows = document.querySelectorAll('tr.fc-list-item, tr.fc-list-event');
      if (!rows[i]) return;
      const titleLink = rows[i].querySelector('td.fc-list-item-title a, td.fc-list-event-title a');
      if (titleLink) titleLink.click();
      else rows[i].click();
    }, idx);

    // FIX: wait longer for popup to render (was 2s → 5s)
    await this.delay(5000);

    // Try main document (popup selectors first, then full page scan)
    let meetingId = await this.page.evaluate(() => {
      const extractId = (str) => {
        if (!str) return '';
        const m = str.match(/[?&]m=([a-f0-9-]+)/i);
        return m ? m[1] : '';
      };

      // Check popup/modal selectors first (from original repo)
      const popupSelectors = [
        '.fc-popover a', '.modal a', '.popup a',
        '[class*="popover"] a', '[class*="modal"] a', '[class*="dialog"] a'
      ];
      for (const sel of popupSelectors) {
        for (const a of document.querySelectorAll(sel)) {
          const id = extractId(a.href);
          if (id) return id;
        }
      }

      const jnr = document.querySelector('a[href*="jnr.jsp"]');
      if (jnr) {
        const p = new URLSearchParams(jnr.href.split('?')[1] || '');
        if (p.get('m')) return p.get('m');
      }

      const mi = document.querySelector('a[href*="mi.jsp"]');
      if (mi) return extractId(mi.href);

      for (const a of document.querySelectorAll('a[href*="m="]')) {
        const id = extractId(a.href);
        if (id) return id;
      }
      return null;
    });

    // FIX: check if page navigated and has meetingId in URL
    if (!meetingId) {
      const urlId = (this.page.url().match(/[?&]m=([a-f0-9-]+)/i) || [])[1];
      if (urlId) {
        this.log(`Meeting ID found in URL after click: ${urlId}`);
        meetingId = urlId;
      }
    }

    // Search all iframes
    if (!meetingId) {
      this.log('Meeting ID not found in main document — searching iframes...');
      try {
        const frames = this.page.frames();
        for (const frame of frames) {
          try {
            const id = await frame.evaluate(() => {
              const extractId = (str) => {
                if (!str) return '';
                const m = str.match(/[?&]m=([a-f0-9-]+)/i);
                return m ? m[1] : '';
              };
              const jnr = document.querySelector('a[href*="jnr.jsp"]');
              if (jnr) return extractId(jnr.href);
              const mi = document.querySelector('a[href*="mi.jsp"]');
              if (mi) return extractId(mi.href);
              const a = document.querySelector('a[href*="m="]');
              return a ? new URLSearchParams(a.href.split('?')[1]).get('m') : null;
            });
            if (id) {
              meetingId = id;
              this.log(`Meeting ID found in iframe: ${id}`);
              break;
            }
          } catch { /* cross-origin frame */ }
        }
      } catch (e) {
        this.log(`iframe search error: ${e.message}`, 'warn');
      }
    }

    // FIX: navigate back safely — only if not already on timetable
    try {
      const curUrl = this.page.url();
      if (!curUrl.includes('m.jsp')) {
        await this.page.goto(TIMETABLE_URL, { waitUntil: 'networkidle2', timeout: 20000 });
        await this.switchToListView();
      }
    } catch (e) {
      this.log(`Could not navigate back to timetable: ${e.message}`, 'warn');
    }

    return meetingId || null;
  }

  /**
   * joinClass — navigate to jnr.jsp, detect too_early/too_late, click Listen Only
   * FIX: returns 'TOO_EARLY' so retryJoinUntilSuccess handles it correctly
   */
  async joinClass(c) {
    const joinUrl = `${BASE_URL}/secure/tla/jnr.jsp?m=${c.meetingId}`;
    this.log(`🔗 Navigating to join URL: ${joinUrl}`);

    try {
      await this.page.goto(joinUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
      this.log(`Navigation timeout — checking page state anyway: ${e.message}`, 'warn');
    }

    await this.delay(5000);

    // Check page content for too-early / too-late
    let pageText = '';
    try {
      pageText = (await this.page.evaluate(() => document.body?.innerText || '')).toLowerCase();
    } catch { }

    if (pageText.includes('too late') || pageText.includes('already ended') || pageText.includes('class has ended')) {
      this.log('⚠️ Class has already ended.', 'warn');
      return false;
    }

    if (pageText.includes('too early') || pageText.includes('not yet open') ||
      pageText.includes('cannot join') || pageText.includes('meeting not started')) {
      this.log('⏳ Teacher hasn\'t started the meeting yet (Too early).');
      return 'TOO_EARLY';
    }

    // Wait for BBB redirect or join page
    try {
      await this.page.waitForFunction(
        () => {
          if (window.location.href.includes('bigbluebutton')) return true;
          const body = document.body ? document.body.innerText.toLowerCase() : '';
          if (body.includes('you are joining') || body.includes('joining the session')) return true;
          const listenBtn = Array.from(document.querySelectorAll('button')).find(
            b => (b.innerText || '').toLowerCase().includes('listen only')
          );
          return !!listenBtn;
        },
        { timeout: 30000, polling: 1000 }
      );
      this.log('✅ Join page confirmed — BBB session detected.');
    } catch {
      this.log('⚠️ BBB confirmation timed out — attempting Listen Only anyway.', 'warn');
    }

    // Try clicking Listen Only in main doc + all iframes, 4 attempts
    const tryClickListenOnly = async (frame) => {
      try {
        return await frame.evaluate(() => {
          const selectors = [
            'button[data-test="listenOnlyBtn"]',
            'button[aria-label="Listen only"]',
            'button[aria-label="listen only"]',
            'button[title="Listen only"]',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) { el.click(); return `selector:${sel}`; }
          }
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const btn = btns.find(b => {
            const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').toLowerCase();
            return label.includes('listen only') || label.includes('listen-only');
          });
          if (btn) { btn.click(); return `text:${btn.textContent.trim().slice(0, 30)}`; }
          return null;
        });
      } catch { return null; }
    };

    for (let attempt = 1; attempt <= 4; attempt++) {
      const mainResult = await tryClickListenOnly(this.page.mainFrame());
      if (mainResult) {
        this.log(`🎧 Listen Only clicked (attempt ${attempt}, main doc: ${mainResult}).`);
        return true;
      }

      let iframeClicked = false;
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame()) continue;
        const result = await tryClickListenOnly(frame);
        if (result) {
          this.log(`🎧 Listen Only clicked (attempt ${attempt}, iframe: ${result}).`);
          iframeClicked = true;
          break;
        }
      }

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
      const match = timeStr.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM|a\.m\.|p\.m\.)?/i);
      if (!match) return null;
      let hours = parseInt(match[1]);
      const mins = parseInt(match[2]);
      const ampm = match[3]?.toUpperCase().replace(/\./g, '');
      if (ampm === 'PM' && hours < 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
      if (!ampm && hours < 8) hours += 12; // infer PM for morning classes

      const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
      const todayIst = new Date(Date.now() + IST_OFFSET_MS);
      const istMidnightUtc = Date.UTC(
        todayIst.getUTCFullYear(),
        todayIst.getUTCMonth(),
        todayIst.getUTCDate()
      ) - IST_OFFSET_MS;
      return istMidnightUtc + (hours * 60 + mins) * 60 * 1000;
    } catch { return null; }
  }

  parseEndTime(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(/[-]|to/i);
    return parts.length > 1 ? this.parseSingleTime(parts[1]) : null;
  }

  async takeScreenshot() {
    if (this.page && !this.page.isClosed()) {
      try {
        const b64 = await this.page.screenshot({ encoding: 'base64', type: 'webp', quality: 50 });
        this.latestScreenshot = b64;
        this.latestScreenshotUrl = this.page.url();
        return b64;
      } catch (e) { return null; }
    }
    return null;
  }

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

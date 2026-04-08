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

      currentClasses.forEach(c => {
        const times = c.time.split(/[-]|to/i).map(t => this.parseSingleTime(t));
        // Mark as ongoing if within 15 mins before start OR within end time
        if (times[0] && times[1] && now >= (times[0] - 15 * 60000) && now < times[1]) {
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
      return { joined: false, action: 'no_active_class_yet' };

    } catch (e) {
      this.log(`Error: ${e.message}`, 'error');
      if (e.message.includes('Target closed') || e.message.includes('Session closed')) {
        this.isLoggedIn = false;
        this.browser = null;
        this.page = null;
      }
      return { joined: false, error: e.message };
    }
  }

  async switchToListView() {
    await this.page.evaluate(() => {
      const btn = document.querySelector('.fc-listView-button') || document.querySelector('button[title="list view"]');
      if (btn) btn.click();
    });
    await this.delay(2000);
  }

  async scrapeClasses() {
    return await this.page.evaluate(() => {
      const results = [];
      document.querySelectorAll('tr.fc-list-item').forEach(row => {
        const time = row.querySelector('.fc-list-item-time')?.textContent.trim() || '';
        const name = row.querySelector('.fc-list-item-title')?.textContent.trim() || '';
        const link = row.querySelector('a[href*="m="]');
        const meetingId = link ? new URLSearchParams(link.href.split('?')[1]).get('m') : '';
        results.push({ name, time, meetingId, status: 'scheduled' });
      });
      return results;
    });
  }

  async clickAndExtractMeetingId(idx) {
    if (!this.page || this.page.isClosed()) return null;
    await this.page.evaluate((i) => {
      const rows = document.querySelectorAll('tr.fc-list-item');
      if (rows[i]) rows[i].click();
    }, idx);
    await this.delay(3000);
    return await this.page.evaluate(() => {
      const a = document.querySelector('a[href*="m="]');
      return a ? new URLSearchParams(a.href.split('?')[1]).get('m') : null;
    });
  }

  async joinClass(c) {
    const joinUrl = `${BASE_URL}/secure/tla/jnr.jsp?m=${c.meetingId}`;
    await this.page.goto(joinUrl, { waitUntil: 'networkidle2' });
    await this.delay(5000);

    await this.page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.toLowerCase().includes('listen only'));
      if (btn) btn.click();
    });

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

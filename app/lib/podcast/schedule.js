// app/lib/podcast/schedule.js
// Reads and changes the Daily Drop launchd/cron schedule through install-podcast-schedule.sh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const LABEL = 'com.sidequest.job-quest.daily-podcast';
const execute = promisify(execFile);

function createPodcastSchedule({ binDir, exec = execute, platform = process.platform, home = os.homedir() } = {}) {
  const helper = path.join(binDir || path.join(home, '.job-quest', 'bin'), 'install-podcast-schedule.sh');
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

  async function status() {
    if (platform === 'darwin') {
      if (!fs.existsSync(plist)) return { installed: false, time: null };
      const text = fs.readFileSync(plist, 'utf-8');
      const hour = text.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
      const minute = text.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
      return { installed: true, time: hour && minute ? `${hour[1].padStart(2, '0')}:${minute[1].padStart(2, '0')}` : null };
    }
    try {
      const { stdout } = await exec('bash', [helper, '--show']);
      const m = String(stdout).match(/^(\d+) (\d+) /m);
      return m ? { installed: true, time: `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` } : { installed: false, time: null };
    } catch { return { installed: false, time: null }; }
  }

  async function install(time) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(time))) throw Object.assign(new Error('Time must look like 08:30.'), { status: 400 });
    if (!fs.existsSync(helper)) throw Object.assign(new Error('The Daily Drop scheduler is not installed yet. Run ~/.job-quest/bin/update.sh, then try again.'), { status: 409 });
    await exec('bash', [helper, time]);
    return status();
  }

  async function uninstall() {
    if (fs.existsSync(helper)) await exec('bash', [helper, '--uninstall']);
    return status();
  }

  return { status, install, uninstall, helper };
}

module.exports = { LABEL, createPodcastSchedule };

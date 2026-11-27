#!/usr/bin/env bash
# Koldvein L7 Hub — all-in-one installer
# Usage: sudo bash install.sh

# --- CRLF self-heal (runs before anything else) ---
if LC_ALL=C grep -q $'\r' "$0" 2>/dev/null; then
  __tmp="$(mktemp)"
  tr -d '\r' < "$0" > "$__tmp"
  chmod +x "$__tmp"
  mv "$__tmp" "$0"
  exec "$0" "$@"
fi

set -Eeuo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; BLD=$'\033[1m'; RST=$'\033[0m'
log(){  printf '%s[*]%s %s\n' "$CYN" "$RST" "$*"; }
ok(){   printf '%s[+]%s %s\n' "$GRN" "$RST" "$*"; }
warn(){ printf '%s[!]%s %s\n' "$YLW" "$RST" "$*"; }
die(){  printf '%s[x]%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
trap 'die "installer failed at line $LINENO"' ERR

# ---------- root & OS check ----------
[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
[[ -f /etc/os-release ]] || die "not Ubuntu/Debian"
. /etc/os-release
case "$ID" in ubuntu|debian) ok "OS: $PRETTY_NAME";; *) die "unsupported: $ID";; esac

# ---------- BOOTSTRAP essential tools ----------
echo
log "bootstrapping essential tools (curl git jq openssl gnupg lsb-release)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || die "apt-get update failed — check VPS network"
apt-get install -y -qq -o DPkg::Lock::Timeout=300 \
  curl ca-certificates gnupg lsb-release apt-transport-https \
  git jq openssl rsync build-essential procps iproute2 \
  || die "bootstrap apt install failed"

for t in curl git jq openssl gpg sed grep awk ps ss; do
  command -v "$t" >/dev/null 2>&1 || die "bootstrap tool missing after install: $t"
done
ok "bootstrap tools ready"

REPO_URL="https://github.com/richpric/Koldvein.git"
ADMIN_CHAT_ID_DEFAULT="7072004980"

echo
echo "${BLD}=== KOLDVEIN L7 HUB — installer ===${RST}"
echo

# ---------- prompts ----------
echo "${BLD}Domain${RST}:"
echo "  • Leave blank to run on VPS public IP with automatic HTTPS via sslip.io"
echo "  • Or enter a domain (e.g. tr.dellix.ir) that already points to this VPS"
read -rp "  Domain (blank = IP mode): " DOMAIN
DOMAIN="$(echo "$DOMAIN" | tr -d '[:space:]')"

read -rp "Email for Let's Encrypt (required for HTTPS, blank = HTTP only): " LE_EMAIL
LE_EMAIL="$(echo "$LE_EMAIL" | tr -d '[:space:]')"

read -rp "Admin username [root]: " ADMIN_USER || true
ADMIN_USER="${ADMIN_USER:-root}"
while :; do
  read -rsp "Admin password (min 3 chars): " ADMIN_PASS; echo
  [[ "${#ADMIN_PASS}" -ge 3 ]] && break
  warn "min 3 chars"
done

BOT_TOKEN=""
while :; do
  read -rp "Telegram bot token (blank to skip bot): " BOT_TOKEN_IN || true
  BOT_TOKEN="$(echo "$BOT_TOKEN_IN" | tr -d '[:space:]')"
  [[ -z "$BOT_TOKEN" ]] && break
  log "validating Telegram bot token..."
  TG_RESP="$(curl -s --max-time 8 "https://api.telegram.org/bot$BOT_TOKEN/getMe" || true)"
  if echo "$TG_RESP" | grep -q '"ok":true'; then
    TG_USER="$(echo "$TG_RESP" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p' | head -1)"
    ok "bot token valid — @${TG_USER:-unknown}"
    break
  fi
  warn "bot token rejected — try again, or Enter to skip."
  warn "response: $(echo "$TG_RESP" | head -c 160)"
  BOT_TOKEN=""
done

ADMIN_CHAT_ID=""
if [[ -n "$BOT_TOKEN" ]]; then
  read -rp "Admin chat id [$ADMIN_CHAT_ID_DEFAULT]: " ADMIN_CHAT_ID || true
  ADMIN_CHAT_ID="${ADMIN_CHAT_ID:-$ADMIN_CHAT_ID_DEFAULT}"
fi

log "detecting public IP..."
PUB_IP="$(curl -s --max-time 5 https://api.ipify.org || true)"
if ! [[ "$PUB_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  PUB_IP="$(curl -s --max-time 5 https://ifconfig.me || true)"
fi
[[ -n "$PUB_IP" ]] || PUB_IP="0.0.0.0"
ok "public IP: $PUB_IP"

SSLDOMAIN=""
if [[ -n "$DOMAIN" ]]; then
  SSLDOMAIN="$DOMAIN"
  ok "domain mode: $DOMAIN"
else
  SSLDOMAIN="${PUB_IP//./-}.sslip.io"
  warn "IP mode — HTTPS will use $SSLDOMAIN (points to $PUB_IP)"
fi

CF_MODE="none"
if [[ -n "$DOMAIN" ]]; then
  echo
  echo "Cloudflare mode: orange (proxied) / gray (DNS only) / none (no CF)"
  read -rp "Mode [orange]: " CF_MODE_IN || true
  CF_MODE="${CF_MODE_IN:-orange}"
  case "$CF_MODE" in orange|gray|none) ;; *) CF_MODE="orange";; esac
  ok "CF mode: $CF_MODE"
else
  ok "Cloudflare skipped (IP mode)"
fi

# ---------- payments ----------
echo
echo "${BLD}=== Payment providers ===${RST}"
echo "Configure Donito (Iran) and/or USDT TRC20 (global). Blank = skip."
DONITO_TOKEN=""
read -rp "Donito token (blank to skip): " DONITO_TOKEN || true
DONITO_TOKEN="$(echo "$DONITO_TOKEN" | tr -d '[:space:]')"
USDT_WALLET=""
read -rp "USDT TRC20 wallet (T... 34 chars, blank to skip): " USDT_WALLET || true
USDT_WALLET="$(echo "$USDT_WALLET" | tr -d '[:space:]')"
if [[ -n "$DONITO_TOKEN" && ${#DONITO_TOKEN} -lt 8 ]]; then
  warn "Donito token looks short — saving anyway (edit later)"
fi
if [[ -n "$USDT_WALLET" && ! "$USDT_WALLET" =~ ^T[1-9A-HJ-NP-Za-km-z]{33}$ ]]; then
  warn "wallet doesn't match TRC20 pattern — saving anyway (edit later)"
fi

# ---------- paths ----------
CFG_DIR="/etc/koldvein"
mkdir -p "$CFG_DIR"; chmod 700 "$CFG_DIR"
PATH_FILE="$CFG_DIR/install.path"
if [[ -f "$PATH_FILE" ]] && [[ -d "$(cat "$PATH_FILE")" ]]; then
  PROJECT_DIR="$(cat "$PATH_FILE")"
  ok "reusing project dir: $PROJECT_DIR"
else
  PROJECT_DIR="/root/koldvein-$(openssl rand -hex 4)"
  mkdir -p "$PROJECT_DIR"; chmod 700 "$PROJECT_DIR"
  echo "$PROJECT_DIR" > "$PATH_FILE"; chmod 600 "$PATH_FILE"
  ok "created project dir: $PROJECT_DIR"
fi
HUB_FILE="$PROJECT_DIR/hub.js"
BOT_FILE="$PROJECT_DIR/bot.js"
DATA_DIR="$PROJECT_DIR/koldvein-data"

# ---------- system packages ----------
log "installing system packages (nginx, certbot, ufw)..."
apt-get update -qq
apt-get install -y -qq -o DPkg::Lock::Timeout=300 \
  nginx certbot python3-certbot-nginx ufw

if [[ ! -f /etc/nginx/nginx.conf ]]; then
  warn "/etc/nginx/nginx.conf missing — reinstalling nginx"
  apt-get install --reinstall -o Dpkg::Options::="--force-confmiss" -y nginx-common nginx
fi
[[ -f /etc/nginx/nginx.conf ]] || die "cannot restore nginx.conf"
ok "system packages installed"

# ---------- node 20 ----------
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then NEED_NODE=1
else
  NODE_MAJ="$(node -v 2>/dev/null | sed 's/^v//;s/\..*//' || echo 0)"
  [[ "$NODE_MAJ" -lt 20 ]] && NEED_NODE=1
fi
command -v npm >/dev/null 2>&1 || NEED_NODE=1

if [[ "$NEED_NODE" -eq 1 ]]; then
  log "installing Node.js 20 + npm from NodeSource..."
  mkdir -p /etc/apt/keyrings
  rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get remove -y -qq nodejs npm libnode-dev 2>/dev/null || true
  apt-get install -y -qq -o DPkg::Lock::Timeout=300 nodejs
fi
command -v node >/dev/null 2>&1 || die "node missing after install"
command -v npm  >/dev/null 2>&1 || die "npm missing after install"
ok "node $(node -v) · npm $(npm -v)"

# ---------- repo ----------
cd "$PROJECT_DIR"
if [[ -d "$PROJECT_DIR/.git" ]]; then
  log "pulling repo..."
  GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" fetch --quiet --depth 1 origin || warn "fetch failed"
  GIT_TERMINAL_PROMPT=0 git -C "$PROJECT_DIR" reset --hard --quiet origin/HEAD 2>/dev/null || true
else
  log "cloning $REPO_URL ..."
  if GIT_TERMINAL_PROMPT=0 git clone --depth 1 -c credential.helper= -c core.askPass=true \
       "$REPO_URL" "$PROJECT_DIR.tmp"; then
    shopt -s dotglob nullglob
    mv "$PROJECT_DIR.tmp/"* "$PROJECT_DIR/" 2>/dev/null || true
    shopt -u dotglob nullglob
    rm -rf "$PROJECT_DIR.tmp"
    ok "cloned"
  else
    warn "clone failed — place files manually in $PROJECT_DIR"
  fi
fi

for f in hub.js bot.js slaves.js backup.js payments.js K0ldvein.js c-rush.js fav.png ppp.txt; do
  if [[ ! -f "$PROJECT_DIR/$f" ]]; then
    FOUND="$(find "$PROJECT_DIR" -maxdepth 4 -type f -name "$f" 2>/dev/null | head -n1 || true)"
    if [[ -n "$FOUND" && "$FOUND" != "$PROJECT_DIR/$f" ]]; then
      mv "$FOUND" "$PROJECT_DIR/$f"
    fi
  fi
done

[[ -f "$HUB_FILE" ]] || die "hub.js not found in $PROJECT_DIR"
ok "hub.js found"
[[ -f "$PROJECT_DIR/slaves.js" ]] || die "slaves.js not found"
ok "slaves.js found"
[[ -f "$PROJECT_DIR/backup.js" ]] || die "backup.js not found"
ok "backup.js found"
[[ -f "$PROJECT_DIR/K0ldvein.js" ]] && ok "K0ldvein.js found" || warn "K0ldvein.js missing — slaves will fail until you upload it"
[[ -f "$PROJECT_DIR/c-rush.js" ]] && ok "c-rush.js found (C-Flood enabled)" || warn "c-rush.js missing — C-Flood method disabled"
[[ -f "$PROJECT_DIR/fav.png" ]] && ok "fav.png found" || warn "fav.png missing — browser tab icon will be blank"
[[ -f "$PROJECT_DIR/payments.js" ]] && ok "payments.js found" || warn "payments.js missing — /api/plans will 404"
if [[ -f "$PROJECT_DIR/ppp.txt" ]]; then
  PROXY_COUNT="$(grep -c ':' "$PROJECT_DIR/ppp.txt" 2>/dev/null || echo 0)"
  ok "ppp.txt found ($PROXY_COUNT entries)"
else
  touch "$PROJECT_DIR/ppp.txt"; chmod 600 "$PROJECT_DIR/ppp.txt"
  warn "ppp.txt missing — created EMPTY (add proxies before deploying)"
fi

# ---------- syntax check ----------
log "syntax-checking scripts..."
node --check "$HUB_FILE" >/tmp/koldvein-hub-syntax.log 2>&1 || { cat /tmp/koldvein-hub-syntax.log >&2; die "hub.js failed syntax check"; }
node --check "$PROJECT_DIR/slaves.js" >/tmp/koldvein-slaves-syntax.log 2>&1 || { cat /tmp/koldvein-slaves-syntax.log >&2; die "slaves.js failed syntax check"; }
node --check "$PROJECT_DIR/backup.js" >/tmp/koldvein-backup-syntax.log 2>&1 || { cat /tmp/koldvein-backup-syntax.log >&2; die "backup.js failed syntax check"; }
if [[ -f "$PROJECT_DIR/payments.js" ]]; then
  node --check "$PROJECT_DIR/payments.js" >/tmp/koldvein-pay-syntax.log 2>&1 || { cat /tmp/koldvein-pay-syntax.log >&2; die "payments.js failed syntax check"; }
fi
if [[ -n "$BOT_TOKEN" ]]; then
  [[ -f "$BOT_FILE" ]] || die "bot.js missing but BOT_TOKEN was provided"
  node --check "$BOT_FILE" >/tmp/koldvein-bot-syntax.log 2>&1 || { cat /tmp/koldvein-bot-syntax.log >&2; die "bot.js failed syntax check"; }
fi
ok "all syntax checks passed"

# ---------- npm deps ----------
log "installing npm dependencies..."

cd "$PROJECT_DIR"
rm -rf node_modules package-lock.json npm-shrinkwrap.json .npm-cache 2>/dev/null || true

cat > "$PROJECT_DIR/package.json" <<'PKG'
{
  "name": "koldvein",
  "version": "1.0.0",
  "private": true,
  "description": "Koldvein L7 Hub",
  "main": "hub.js",
  "scripts": {
    "start": "node hub.js",
    "bot":   "node bot.js"
  }
}
PKG

export npm_config_prefix="$PROJECT_DIR"
export npm_config_cache="$PROJECT_DIR/.npm-cache"

# One call. Everything unpinned EXCEPT node-telegram-bot-api, which is pinned
# to 0.66.0 because v0.67+ is ESM-only ("type":"module") and breaks require().
log "  installing: express express-session express-rate-limit helmet bcryptjs ssh2 hpack colors axios node-bash-title node-telegram-bot-api@0.66.0"
npm install --no-audit --no-fund \
  express express-session express-rate-limit helmet bcryptjs ssh2 \
  hpack colors axios node-bash-title \
  node-telegram-bot-api@0.66.0 \
  || die "npm install failed"

# Verify every module is present AND loadable (via require, the way bot.js loads it)
REQUIRED=(express express-session express-rate-limit helmet bcryptjs ssh2 hpack colors axios node-bash-title node-telegram-bot-api)

for m in "${REQUIRED[@]}"; do
  [[ -d "$PROJECT_DIR/node_modules/$m" ]] || die "module missing: $m"
  ( cd "$PROJECT_DIR" && node -e "require('$m')" >/dev/null 2>&1 ) \
    || die "module installed but not loadable via require: $m"
done
ok "npm deps installed (${#REQUIRED[@]} modules verified)"

# Confirm the installed telegram-bot-api version is the pinned CJS one
TG_VERSION="$( cd "$PROJECT_DIR" && node -e 'console.log(require("node-telegram-bot-api/package.json").version)' 2>/dev/null || echo '?' )"
if [[ "$TG_VERSION" != "0.66.0" ]]; then
  die "node-telegram-bot-api is $TG_VERSION, expected 0.66.0 (ESM-only versions break require())"
fi
ok "node-telegram-bot-api@$TG_VERSION (CommonJS) confirmed"

# Constructor sanity
( cd "$PROJECT_DIR" && node -e '
  const T = require("node-telegram-bot-api");
  let C = typeof T==="function" ? T
        : (T && typeof T.default==="function" ? T.default
        : (T && typeof T.Bot==="function" ? T.Bot : null));
  if (typeof C!=="function") { console.error("no ctor"); process.exit(2); }
  const p = new C("1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",{polling:false});
  if (!p.getMe || !p.sendMessage) process.exit(3);
  process.exit(0);
' ) || die "node-telegram-bot-api verification failed"
ok "node-telegram-bot-api constructor verified"

# ---------- ufw ----------
log "configuring firewall..."
ufw --force default deny incoming  >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
if [[ "$CF_MODE" == "orange" ]]; then
  log "restricting 80/443 to Cloudflare edge..."
  ufw --force delete allow 80/tcp  >/dev/null 2>&1 || true
  ufw --force delete allow 443/tcp >/dev/null 2>&1 || true
  CF_RANGES=(
    173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22
    141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20
    197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13
    104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
  )
  for r in "${CF_RANGES[@]}"; do
    ufw allow from "$r" to any port 80  proto tcp >/dev/null
    ufw allow from "$r" to any port 443 proto tcp >/dev/null
  done
fi
ufw --force enable >/dev/null
ok "ufw: $(ufw status | head -1 | awk '{print $2}')"

# ---------- SSL cert ----------
CERT_PATH=""; KEY_PATH=""
if [[ -n "$LE_EMAIL" ]]; then
  log "requesting SSL for $SSLDOMAIN via Let's Encrypt..."
  systemctl stop nginx 2>/dev/null || true
  if certbot certonly --standalone --non-interactive --agree-tos --email "$LE_EMAIL" \
       -d "$SSLDOMAIN" --keep-until-expiring 2>/tmp/certbot.log; then
    CERT_PATH="/etc/letsencrypt/live/$SSLDOMAIN/fullchain.pem"
    KEY_PATH="/etc/letsencrypt/live/$SSLDOMAIN/privkey.pem"
    ok "SSL cert: $CERT_PATH"
  else
    warn "certbot failed — continuing without SSL"
    warn "reason: $(tail -n 5 /tmp/certbot.log 2>/dev/null | tr '\n' ' ')"
  fi
else
  warn "no email provided — skipping SSL (HTTP only)"
fi

# ---------- mini app URL ----------
MINI_APP_URL=""
if [[ -n "$BOT_TOKEN" ]]; then
  if [[ -n "$CERT_PATH" ]]; then
    DEFAULT_MINI_APP_URL="https://$SSLDOMAIN"
  else
    DEFAULT_MINI_APP_URL="http://$PUB_IP"
  fi
  read -rp "Mini App URL [$DEFAULT_MINI_APP_URL]: " MINI_APP_URL || true
  MINI_APP_URL="${MINI_APP_URL:-$DEFAULT_MINI_APP_URL}"
  if [[ "$MINI_APP_URL" == https://* && -z "$CERT_PATH" ]]; then
    warn "Mini App URL is HTTPS but no cert — bot will fall back to a plain link button."
  fi
fi

# ---------- data dir & payments.json ----------
mkdir -p "$DATA_DIR"; chmod 700 "$DATA_DIR"
PAY_FILE="$DATA_DIR/payments.json"
if [[ ! -f "$PAY_FILE" ]]; then
  echo '{"wallet":"","donitoToken":"","createdAt":"'"$(date -u +%FT%TZ)"'"}' > "$PAY_FILE"
fi
jq --arg w "$USDT_WALLET" --arg t "$DONITO_TOKEN" \
  '.wallet=$w | .donitoToken=$t | .updatedAt=(now|todate)' "$PAY_FILE" > "$PAY_FILE.tmp" \
  && mv "$PAY_FILE.tmp" "$PAY_FILE"
chmod 600 "$PAY_FILE"
ok "payments.json written (wallet='${USDT_WALLET:0:6}…' donito='${DONITO_TOKEN:0:4}…')"

# ---------- env ----------
log "writing env files..."
ENV_FILE="$CFG_DIR/hub.env"
BOT_ENV_FILE="$CFG_DIR/bot.env"

cd "$PROJECT_DIR"
node -e "require('bcryptjs');" >/dev/null 2>&1 || die "bcryptjs not usable from $PROJECT_DIR"
ADMIN_HASH="$(node -e "const b=require('bcryptjs');b.hash(process.argv[1],12).then(h=>process.stdout.write(h));" "$ADMIN_PASS")"
[[ -n "$ADMIN_HASH" ]] || die "hash failed"
SESSION_SECRET="$(openssl rand -hex 32)"
BOT_NOTIFY_SECRET="$(openssl rand -hex 32)"
cookie_secure=false
[[ -n "$CERT_PATH" ]] && cookie_secure=true
[[ "$CF_MODE" == "orange" ]] && cookie_secure=true

: > "$ENV_FILE"
cat > "$ENV_FILE" <<ENV
SESSION_SECRET=$SESSION_SECRET
ADMIN_USERNAME=$ADMIN_USER
ADMIN_PASSWORD_HASH=$ADMIN_HASH
HUB_HOST=127.0.0.1
PORT=3000
HUB_DOMAIN=$DOMAIN
CF_MODE=$CF_MODE
COOKIE_SECURE=$cookie_secure
HUB_EMAIL=$LE_EMAIL
HUB_SSL_CERT=$CERT_PATH
HUB_SSL_KEY=$KEY_PATH
HUB_PUBLIC_IP=$PUB_IP
PAYMENTS_SKIP_PROMPT=1
BOT_NOTIFY_HOST=127.0.0.1
BOT_NOTIFY_PORT=3099
BOT_NOTIFY_SECRET=$BOT_NOTIFY_SECRET
SLAVE_ZIP_URL=
ENV
chmod 600 "$ENV_FILE"

: > "$BOT_ENV_FILE"
cat > "$BOT_ENV_FILE" <<ENV
BOT_TOKEN=$BOT_TOKEN
MINI_APP_URL=$MINI_APP_URL
HUB_DOMAIN=$DOMAIN
HUB_PUBLIC_IP=$PUB_IP
ADMIN_CHAT_ID=$ADMIN_CHAT_ID
BOT_NOTIFY_SECRET=$BOT_NOTIFY_SECRET
BOT_NOTIFY_PORT=3099
ENV
chmod 600 "$BOT_ENV_FILE"

for ef in "$ENV_FILE" "$BOT_ENV_FILE"; do
  if grep -qE '<[a-zA-Z/!]' "$ef"; then die "$(basename "$ef") contains HTML/XML"; fi
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || die "$(basename "$ef") invalid: $line"
  done < "$ef"
done
ok "env written and validated"

# ---------- nginx ----------
log "writing nginx site..."
NGINX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p')"
HTTP2_STYLE="none"
if [[ -n "$NGINX_VER" ]]; then
  MAJ="${NGINX_VER%%.*}"; rest="${NGINX_VER#*.}"; MIN="${rest%%.*}"
  if (( MAJ > 1 )) || { (( MAJ == 1 )) && (( MIN >= 25 )); }; then HTTP2_STYLE="modern"
  elif (( MAJ == 1 )) && (( MIN >= 9 )); then HTTP2_STYLE="legacy"; fi
fi

CF_REAL_IP=""
if [[ "$CF_MODE" == "orange" ]]; then
  CF_REAL_IP="$(cat <<'CFIP'
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 131.0.72.0/22;
    real_ip_header CF-Connecting-IP;
    real_ip_recursive on;
CFIP
)"
fi

SERVER_NAME="$SSLDOMAIN"
[[ -n "$DOMAIN" ]] && SERVER_NAME="$DOMAIN $SSLDOMAIN"
SERVER_NAME="$SERVER_NAME $PUB_IP _"

LISTEN_443=""; TLS_BLOCK=""
if [[ -n "$CERT_PATH" ]]; then
  case "$HTTP2_STYLE" in
    modern) LISTEN_443=$'    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;';;
    legacy) LISTEN_443=$'    listen 443 ssl http2;\n    listen [::]:443 ssl http2;';;
    *)      LISTEN_443=$'    listen 443 ssl;\n    listen [::]:443 ssl;';;
  esac
  TLS_BLOCK="$(cat <<TLSEOF
$LISTEN_443
    ssl_certificate     $CERT_PATH;
    ssl_certificate_key $KEY_PATH;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_ecdh_curve X25519:prime256v1:secp384r1;
    ssl_session_cache shared:SSL:50m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
$CF_REAL_IP
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
TLSEOF
)"
fi

PORT80_BODY="$(cat <<'PLAIN'
    client_max_body_size 128k;
    location /api/ {
        proxy_pass http://koldvein_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
    location / {
        proxy_pass http://koldvein_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
PLAIN
)"
[[ -n "$CERT_PATH" ]] && PORT80_BODY='    return 301 https://$host$request_uri;'

TLS_SERVER=""
if [[ -n "$CERT_PATH" ]]; then
  TLS_SERVER="$(cat <<TLSERVER

server {
$TLS_BLOCK
    server_name $SERVER_NAME;
    client_max_body_size 128k;
    location = /favicon.ico { proxy_pass http://koldvein_backend; }
    location = /robots.txt  { access_log off; return 200 "User-agent: *\nDisallow: /\n"; add_header Content-Type text/plain; }
    location /api/ {
        proxy_pass http://koldvein_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
    location / {
        proxy_pass http://koldvein_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
}
TLSERVER
)"
fi

cat > /etc/nginx/sites-available/koldvein.conf <<NGINX
upstream koldvein_backend {
    server 127.0.0.1:3000;
    keepalive 64;
    keepalive_requests 500;
    keepalive_timeout 30s;
}
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $SERVER_NAME;
$PORT80_BODY
}
$TLS_SERVER
NGINX
ln -sf /etc/nginx/sites-available/koldvein.conf /etc/nginx/sites-enabled/koldvein.conf
rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/privhub.conf 2>/dev/null || true
nginx -t 2>&1 | tee /tmp/ngx-test.log | grep -q 'test is successful' || { cat /tmp/ngx-test.log >&2; die "nginx config invalid"; }
ok "nginx site valid"

# ---------- systemd ----------
log "writing systemd units..."
NODE_BIN="$(command -v node)"

cat > /etc/systemd/system/koldvein.service <<UNIT
[Unit]
Description=Koldvein L7 Hub (web + API + slaves orchestrator)
After=network-online.target nginx.service
Wants=nginx.service

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=-$ENV_FILE
Environment=NODE_ENV=production
Environment=PAYMENTS_SKIP_PROMPT=1
Environment=UV_THREADPOOL_SIZE=64
ExecStart=$NODE_BIN $HUB_FILE
Restart=always
RestartSec=3
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=15
StandardInput=null

[Install]
WantedBy=multi-user.target
UNIT

if [[ -n "$BOT_TOKEN" ]]; then
  cat > /etc/systemd/system/koldvein-bot.service <<UNIT
[Unit]
Description=Koldvein Telegram Bot
After=network-online.target koldvein.service
Wants=network-online.target
Requires=koldvein.service

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
EnvironmentFile=-$BOT_ENV_FILE
ExecStart=$NODE_BIN $BOT_FILE
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=10
Environment=NODE_ENV=production
StandardInput=null

[Install]
WantedBy=multi-user.target
UNIT
fi

rm -f /etc/systemd/system/privhub.service /etc/systemd/system/privbot.service 2>/dev/null || true

systemctl daemon-reload
systemctl enable koldvein >/dev/null
[[ -n "$BOT_TOKEN" ]] && systemctl enable koldvein-bot >/dev/null
ok "systemd units installed"

# ---------- free ports ----------
free_ports(){
  local pids
  pids="$(ss -ltnp 2>/dev/null | awk '/:80 |:443 |:3000 |:3099 / {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  [[ -z "$pids" ]] && return 0
  for pid in $pids; do
    local comm; comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
    [[ "$comm" == "nginx" ]] && continue
    warn "port held by pid=$pid ($comm) — killing"
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 1
}
free_ports || true

# ---------- start services ----------
log "starting nginx..."
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reset-failed nginx 2>/dev/null || true
NGINX_OK=0
for i in 1 2 3; do
  if systemctl restart nginx 2>/dev/null; then sleep 1; systemctl is-active --quiet nginx && { NGINX_OK=1; break; }; fi
  warn "nginx attempt $i failed — cleaning"
  systemctl stop nginx 2>/dev/null || true
  pkill -9 nginx 2>/dev/null || true
  sleep 1
  free_ports || true
done
[[ "$NGINX_OK" -eq 1 ]] || { journalctl -u nginx -n 40 --no-pager >&2 || true; die "nginx failed"; }
ok "nginx: $(systemctl is-active nginx)"

log "starting koldvein..."
systemctl reset-failed koldvein 2>/dev/null || true
systemctl restart koldvein || true
sleep 6
systemctl is-active --quiet koldvein || { journalctl -u koldvein -n 120 --no-pager >&2 || true; die "koldvein failed"; }
ok "koldvein: $(systemctl is-active koldvein)"

BOT_STATUS="disabled"
if [[ -n "$BOT_TOKEN" ]]; then
  log "starting koldvein-bot..."
  systemctl reset-failed koldvein-bot 2>/dev/null || true
  systemctl restart koldvein-bot || true
  sleep 5
  if systemctl is-active --quiet koldvein-bot; then
    BOT_STATUS="$(systemctl is-active koldvein-bot)"
    ok "koldvein-bot: $BOT_STATUS"
  else
    BOT_STATUS="failed"
    warn "koldvein-bot failed — logs:"
    journalctl -u koldvein-bot -n 80 --no-pager >&2 || true
  fi
fi

# ---------- self-test ----------
echo
log "self test..."
sleep 1
HUB_CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || echo 000)"
NGX_HTTP="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $SSLDOMAIN" http://127.0.0.1/ || echo 000)"
NGX_HTTPS="(no TLS)"
if [[ -n "$CERT_PATH" ]]; then
  NGX_HTTPS="$(curl -sk -o /dev/null -w '%{http_code}' -H "Host: $SSLDOMAIN" https://127.0.0.1/api/health || echo 000)"
fi
LISTEN="$(ss -ltnp 2>/dev/null | grep -E ':80|:443|:3000|:3099' | awk '{print $4}' | sort -u | tr '\n' ' ')"
echo
echo "${BLD}=== SELF-TEST ===${RST}"
printf '  hub  /api/health : %s\n' "$HUB_CODE"
printf '  nginx http       : %s\n' "$NGX_HTTP"
printf '  nginx https      : %s\n' "$NGX_HTTPS"
printf '  listeners        : %s\n' "$LISTEN"
printf '  koldvein.service : %s\n' "$(systemctl is-active koldvein || true)"
[[ -n "$BOT_TOKEN" ]] && printf '  koldvein-bot.svc : %s\n' "$BOT_STATUS"
echo

if [[ "$HUB_CODE" != "200" ]]; then
  warn "koldvein running but /api/health did not return 200 — check logs:"
  journalctl -u koldvein -n 80 --no-pager >&2 || true
fi

# ---------- summary ----------
ACCESS_URL=""
if [[ -n "$CERT_PATH" ]]; then
  ACCESS_URL="https://$SSLDOMAIN"
else
  ACCESS_URL="http://$PUB_IP"
fi

echo "${GRN}${BLD}=========================${RST}"
echo "${GRN}${BLD} KOLDVEIN L7 — READY${RST}"
echo "${GRN}${BLD}=========================${RST}"
echo
echo "  Access  : $ACCESS_URL"
if [[ -z "$DOMAIN" ]]; then
  echo "            (sslip.io points to $PUB_IP, so HTTPS works without a domain)"
fi
echo "  Admin   : $ADMIN_USER"
echo "  Project : $PROJECT_DIR"
echo "  Data    : $DATA_DIR"
echo "  Bot     : ${BOT_TOKEN:+enabled (Mini App: $MINI_APP_URL)}${BOT_TOKEN:-disabled}"
echo "  Payments: wallet=${USDT_WALLET:+set}${USDT_WALLET:-not set}  donito=${DONITO_TOKEN:+set}${DONITO_TOKEN:-not set}"
echo "  Services: sudo systemctl {status|restart} koldvein"
[[ -n "$BOT_TOKEN" ]] && echo "            sudo systemctl {status|restart} koldvein-bot"
echo "  Logs    : sudo journalctl -u koldvein -f"
[[ -n "$BOT_TOKEN" ]] && echo "            sudo journalctl -u koldvein-bot -f"
echo
if [[ -z "$DOMAIN" ]]; then
  echo "  ${YLW}IP MODE REMINDER:${RST}"
  echo "    • Public URL: https://$SSLDOMAIN"
  echo "    • Raw IP:     http://$PUB_IP"
  echo "    • Cert auto-renews via certbot systemd timer"
elif [[ "$CF_MODE" == "orange" ]]; then
  echo "  ${YLW}CF mode = orange — set DNS in Cloudflare to proxied${RST}"
elif [[ "$CF_MODE" == "gray" ]]; then
  echo "  ${YLW}CF mode = gray — A record for $DOMAIN → $PUB_IP, DNS-only${RST}"
fi
if [[ -n "$BOT_TOKEN" ]]; then
  echo
  echo "  ${YLW}IMPORTANT: Register the Mini App URL in BotFather:${RST}"
  echo "    /newapp → pick your bot → Web App URL: $MINI_APP_URL"
fi
echo
echo "  ${YLW}Before deploying attacks:${RST}"
echo "    1. Add proxies to $PROJECT_DIR/ppp.txt (one per line)"
echo "    2. Sign in as admin → Settings → Slaves → add at least one VPS"
echo "    3. Wait for slave status to become \"ready\" (2-4 min)"
echo
echo "  Open $ACCESS_URL and sign in as $ADMIN_USER"
echo

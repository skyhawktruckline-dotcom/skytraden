// server.js - COMPLETE Skytraden backend (merge of all modules)
// Run: npm install && npm start
// Needs a .env file beside this (see .env.example)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const PAPER_URL = "https://paper-api.alpaca.markets";
const LIVE_URL = "https://api.alpaca.markets";
const baseUrl = () => (process.env.ALPACA_ENV === "live" ? LIVE_URL : PAPER_URL);

const DATA_URL = "https://data.alpaca.markets"; // market data lives here (same keys)

async function alpacaFetch(path, options = {}, creds = null) {
  // price/chart data -> data.alpaca.markets, trading -> paper/api.alpaca.markets
  const base = path.startsWith("/v2/stocks") ? DATA_URL : baseUrl();
  const res = await fetch(base + path, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": (creds && creds.key) || process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": (creds && creds.secret) || process.env.ALPACA_SECRET,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || "Alpaca API error");
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

// ---- Simple cache: prevents hammering Alpaca's 200 req/min limit ----
// Quotes cached 10s, bars cached 60s. Multiple tabs/clicks stay free.
const cache = new Map();
async function cached(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const data = await fetcher();
  cache.set(key, { t: Date.now(), data });
  return data;
}

const app = express();
const PORT = process.env.PORT || 3001;

// PNA header must be set on EVERY response including OPTIONS preflights,
// so it goes BEFORE cors (which answers preflights itself)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});

// Accept requests from any domain (skytraden.com, www., localhost, etc.)
// Paper-trading API; harden later with API_ACCESS_KEY for production.
app.use(cors({ origin: true }));

app.use(express.json());
app.use(express.static(__dirname)); // open http://localhost:3001 as fallback

// Optional shared-secret for frontend -> backend calls
app.use((req, res, next) => {
  const expected = process.env.API_ACCESS_KEY;
  if (expected && req.headers["x-api-key"] !== expected)
    return res.status(401).json({ error: "Invalid or missing API key" });
  next();
});

// ============ BOT CONFIG (persisted to disk) ============
const CONFIG_FILE = "./bot-config.json";
let botConfig = {
  enabled: false,
  symbols: ["NVDA", "AAPL", "MSFT"],
  allocationType: "percent",
  allocationValue: 5,
  maxOpenPositions: 3,
  maxDailyLoss: 500,
  stopLossPct: 2,
  takeProfitPct: 4,
  allowShorts: true,
  strategy: "RSI Mean Reversion",
  timeframe: "15Min",
};
if (fs.existsSync(CONFIG_FILE))
  botConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));

app.get("/api/bot/config", (req, res) => res.json(botConfig));
app.post("/api/bot/config", (req, res) => {
  botConfig = { ...botConfig, ...req.body };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
  res.json(botConfig);
});

// Daily kill switch check
let dayStartEquity = null;
setInterval(async () => {
  try {
    const acc = await alpacaFetch("/v2/account");
    if (!dayStartEquity) dayStartEquity = parseFloat(acc.equity);
    if (dayStartEquity - parseFloat(acc.equity) >= botConfig.maxDailyLoss) {
      botConfig.enabled = false;
      await alpacaFetch("/v2/orders", { method: "DELETE" });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
      console.log("KILL SWITCH: daily loss limit hit, bot stopped");
    }
  } catch {}
}, 60000);

// ============ USER ACCOUNTS (customer sign-up / login) ============
const crypto = require("crypto");
const USERS_FILE = "./users.json";
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) : [];
const sessions = new Map(); // token -> username
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString("hex"); }

app.post("/api/signup", (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Username: 3-20 letters/numbers/underscore" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be 6+ characters" });
  if (users.some(u => u.username.toLowerCase() === String(username).toLowerCase()))
    return res.status(409).json({ error: "That username is taken" });
  const salt = crypto.randomBytes(16).toString("hex");
  users.push({ username: String(username), email: String(email || ""), salt, hash: hashPw(password, salt), created: new Date().toISOString() });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = users.find(x => x.username.toLowerCase() === String(username || "").toLowerCase());
  if (!u || hashPw(password || "", u.salt) !== u.hash)
    return res.status(401).json({ error: "Wrong username or password" });
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, u.username);
  res.json({ token, username: u.username, pro: ADMIN_USERS.includes(u.username.toLowerCase()) || !!u.pro });
});

app.get("/api/me", (req, res) => {
  const u = sessions.get(req.headers["x-session"]);
  const uu = users.find(x => x.username === u);
  res.json({ username: u || null, pro: u ? (ADMIN_USERS.includes(u.toLowerCase()) || !!uu.pro) : false });
});

// ============ BOT TRADE JOURNAL (server-side history) ============
const BTRADES_FILE = "./bot-trades.json";
let botTrades = fs.existsSync(BTRADES_FILE) ? JSON.parse(fs.readFileSync(BTRADES_FILE, "utf8")) : [];
app.get("/api/bot/trades", (req, res) => res.json(botTrades.slice(-200).reverse()));
app.post("/api/bot/trades", (req, res) => {
  const t = req.body || {};
  botTrades.push({ ...t, serverTime: new Date().toISOString() });
  if (botTrades.length > 2000) botTrades = botTrades.slice(-2000);
  fs.writeFileSync(BTRADES_FILE, JSON.stringify(botTrades, null, 1));
  res.json({ ok: true });
});

// Yahoo quote for ANY symbol incl. futures (ES=F, NQ=F, CL=F, GC=F...) - cached 8s
app.get("/api/yquote/:symbol", async (req, res) => {
  try {
    const s = req.params.symbol;
    // ?fast=1 -> ~1s cache for the watched contract; default 8s for the rest
    const ttl = req.query.fast ? 1100 : 8000;
    const d = await cached("yq:" + s, ttl, async () => {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&range=1d`,
        { headers: { "User-Agent": "Mozilla/5.0 (Skytraden)" } });
      const j = await r.json();
      const m = j?.chart?.result?.[0]?.meta;
      if (!m || m.regularMarketPrice == null) throw new Error("no quote");
      return { price: m.regularMarketPrice, prev: m.chartPreviousClose || m.previousClose || m.regularMarketPrice, name: m.longName || m.shortName || s };
    });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crypto kline history (Binance, public). Browser can't call Binance directly
// (CORS), so we proxy it. Live ticks go browser <-> Binance WebSocket directly.
app.get("/api/cklines/:symbol", async (req, res) => {
  try {
    const s = req.params.symbol.toUpperCase();
    const iv = req.query.interval || "15m";
    const d = await cached("ck:" + s + ":" + iv, 10000, async () => {
      // Binance geo-blocks some cloud IPs (e.g. US-based hosts). Try the public
      // data mirror first, then the main API, then Yahoo as last resort.
      const hosts = ["https://data-api.binance.vision", "https://api.binance.com"];
      for (const host of hosts) {
        try {
          const r = await fetch(`${host}/api/v3/klines?symbol=${s}&interval=${iv}&limit=300`);
          const k = await r.json();
          if (Array.isArray(k) && k.length) return k.map(x => ({ time: Math.floor(x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }));
        } catch {}
      }
      // Yahoo fallback (works for crypto as BTC-USD etc.)
      const ym = { "1m": ["1m", "1d"], "5m": ["5m", "5d"], "15m": ["15m", "1mo"], "30m": ["30m", "1mo"], "1h": ["60m", "1mo"], "4h": ["60m", "3mo"], "1d": ["1d", "6mo"], "1w": ["1d", "1y"] };
      const ysym = s.replace("USDT", "-USD");
      const [yi, yr] = (ym[iv] || ym["15m"]);
      const r2 = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ysym}?interval=${yi}&range=${yr}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const j2 = await r2.json();
      const res = j2?.chart?.result?.[0]; if (!res) throw new Error("no klines from any source");
      const q = res.indicators?.quote?.[0] || {}; const ts = res.timestamp || [];
      const out = [];
      for (let i = 0; i < ts.length; i++) { if (q.open?.[i] == null) continue; out.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 }); }
      if (!out.length) throw new Error("no klines from any source");
      return out;
    });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== REAL CRYPTO TRADING (BYOK keys in request headers; Binance + testnet) =====
// Testnet keys (free, no KYC): https://testnet.binance.vision
app.post("/api/bn/order", async (req, res) => {
  try {
    const key = req.headers["x-bn-key"], sec = req.headers["x-bn-secret"];
    if (!key || !sec) return res.status(400).json({ error: "Add your exchange API keys in the API Key panel first" });
    const testnet = req.headers["x-bn-testnet"] === "1";
    const base = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
    const { symbol, side, qty } = req.body || {};
    const params = new URLSearchParams({ symbol: String(symbol || "").toUpperCase(), side: String(side).toUpperCase() === "BUY" ? "BUY" : "SELL", type: "MARKET", quantity: String(qty), timestamp: String(Date.now()) });
    params.append("signature", crypto.createHmac("sha256", sec).update(params.toString()).digest("hex"));
    const r = await fetch(base + "/api/v3/order?" + params.toString(), { method: "POST", headers: { "X-MBX-APIKEY": key } });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.msg || "Exchange rejected the order" });
    res.json({ ok: true, filled: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/bn/account", async (req, res) => {
  try {
    const key = req.headers["x-bn-key"], sec = req.headers["x-bn-secret"];
    if (!key || !sec) return res.status(400).json({ error: "Missing keys" });
    const testnet = req.headers["x-bn-testnet"] === "1";
    const base = testnet ? "https://testnet.binance.vision" : "https://api.binance.com";
    const params = new URLSearchParams({ timestamp: String(Date.now()) });
    params.append("signature", crypto.createHmac("sha256", sec).update(params.toString()).digest("hex"));
    const r = await fetch(base + "/api/v3/account?" + params.toString(), { headers: { "X-MBX-APIKEY": key } });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.msg || "error" });
    res.json({ ok: true, balances: (d.balances || []).filter(b => parseFloat(b.free) > 0).slice(0, 12) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== LIVE NEWS (free RSS, no key needed) =====
app.get("/api/news", async (req, res) => {
  try {
    const d = await cached("newsfeed", 600000, async () => {
      const feeds = [
        ["https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA,AAPL,TSLA,SPY&region=US&lang=en-US", "STOCKS"],
        ["https://www.coindesk.com/arc/outboundfeeds/rss/", "CRYPTO"],
        ["https://cointelegraph.com/rss", "CRYPTO"]
      ];
      const out = [];
      for (const [u, cat] of feeds) {
        try {
          const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Skytraden)" } });
          const x = await r.text();
          const grab = (t, tag) => { const m = t.match(new RegExp("<" + tag + ">(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</" + tag + ">")); return m ? m[1].replace(/<[^>]+>/g, "").trim() : ""; };
          [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).forEach(m => out.push({ title: grab(m[1], "title"), link: grab(m[1], "link"), pub: grab(m[1], "pubDate"), cat }));
        } catch {}
      }
      return out.sort((a, b) => new Date(b.pub) - new Date(a.pub)).slice(0, 25);
    });
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== ADMIN PRO FLAG + PROMO CODES =====
const ADMIN_USERS = (process.env.ADMIN_USERS || "skytraden").split(",").map(s => s.trim().toLowerCase());

const PROMO_FILE = "./promo-codes.json";
let promos = fs.existsSync(PROMO_FILE) ? JSON.parse(fs.readFileSync(PROMO_FILE, "utf8")) : {};

function adminOk(req) {
  const k = process.env.ADMIN_KEY;
  return k && req.headers["x-admin-key"] === k;
}
app.post("/api/promo/validate", (req, res) => {
  const code = String((req.body || {}).code || "").trim().toUpperCase();
  const p = promos[code];
  if (!p || !p.active) return res.json({ valid: false });
  if (p.maxUses && p.uses >= p.maxUses) return res.json({ valid: false, msg: "Code limit reached" });
  res.json({ valid: true, discount: p.discount, price: +(29 * (1 - p.discount / 100)).toFixed(2) });
});
app.post("/api/promo/redeem", (req, res) => {  // called after PayPal capture (or manual use)
  const code = String((req.body || {}).code || "").trim().toUpperCase();
  if (promos[code]) { promos[code].uses++; fs.writeFileSync(PROMO_FILE, JSON.stringify(promos, null, 1)); }
  res.json({ ok: true });
});
app.post("/api/promo/create", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Admin key required (set ADMIN_KEY env var on Railway)" });
  const { code, discount, maxUses } = req.body || {};
  if (!code || !discount) return res.status(400).json({ error: "code + discount required" });
  const c = String(code).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  promos[c] = { discount: Math.min(100, Math.max(1, +discount)), maxUses: +maxUses || 0, uses: 0, active: true, created: new Date().toISOString() };
  fs.writeFileSync(PROMO_FILE, JSON.stringify(promos, null, 1));
  res.json({ ok: true, code: c });
});
app.get("/api/promo/list", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Admin key required" });
  res.json(Object.entries(promos).map(([c, p]) => ({ code: c, ...p })));
});
app.post("/api/promo/toggle", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Admin key required" });
  const c = String((req.body || {}).code || "").trim().toUpperCase();
  if (promos[c]) { promos[c].active = !promos[c].active; fs.writeFileSync(PROMO_FILE, JSON.stringify(promos, null, 1)); }
  res.json({ ok: true });
});

// ===== ADMIN: manage Pro access for paying customers =====
app.get("/api/admin/users", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Admin key required" });
  res.json(users.map(u => ({ username: u.username, pro: !!u.pro, created: u.created })).sort((a, b) => a.username.localeCompare(b.username)));
});
app.post("/api/admin/grant-pro", (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: "Admin key required" });
  const { username, pro } = req.body || {};
  const u = users.find(x => x.username.toLowerCase() === String(username || "").toLowerCase());
  if (!u) return res.status(404).json({ error: "User not found — they must sign up first" });
  u.pro = pro !== false;
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  res.json({ ok: true, username: u.username, pro: u.pro });
});

// ============ TRADING ROUTES ============
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", env: process.env.ALPACA_ENV || "paper", time: new Date().toISOString() }));

app.get("/api/account", async (req, res) => {
  try {
    const uc = userCreds(req);
    const f = () => alpacaFetch("/v2/account", {}, uc);
    res.json(uc ? await f() : await cached("acct", 10000, f));
  }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

// Live quote: GET /api/quote/AAPL
app.get("/api/quote/:symbol", async (req, res) => {
  try { const s = req.params.symbol.toUpperCase(); res.json(await cached("q:" + s, 10000, () => alpacaFetch(`/v2/stocks/${s}/quotes/latest?feed=iex`))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

// Chart history: GET /api/bars/NVDA?timeframe=15Min&limit=300
// Yahoo Finance fallback for chart history (free, no key needed)
const YF_TFS = {
  "1Min":  { interval: "1m",  range: "5d"   },
  "1m":    { interval: "1m",  range: "5d"   },
  "5Min":  { interval: "5m",  range: "1mo"  },
  "5m":    { interval: "5m",  range: "1mo"  },
  "15Min": { interval: "15m", range: "1mo"  },
  "15m":   { interval: "15m", range: "1mo"  },
  "30Min": { interval: "30m", range: "1mo"  },
  "30m":   { interval: "30m", range: "1mo"  },
  "60Min": { interval: "60m", range: "3mo"  },
  "60m":   { interval: "60m", range: "3mo"  },
  "1Hour": { interval: "60m", range: "3mo"  },
  "1Day":  { interval: "1d",  range: "1y"   },
  "1D":    { interval: "1d",  range: "1y"   },
};

async function yahooBars(symbol, timeframe) {
  const tf = YF_TFS[timeframe] || YF_TFS["15Min"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${tf.interval}&range=${tf.range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Skytraden paper trading app)" },
  });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo returned no chart data");
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open?.[i] == null || q.close?.[i] == null) continue; // skip bad bars
    out.push({
      time: ts[i],
      open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: q.volume?.[i] || 0,
    });
  }
  return out;
}

app.get("/api/bars/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const timeframe = req.query.timeframe || "15Min";
    let candles = await cached(`b:${symbol}:${timeframe}`, 30000, async () => {
      // Try Alpaca first
      try {
        const data = await alpacaFetch(`/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=300&feed=iex`);
        let bars = data.bars;
        if (!Array.isArray(bars)) bars = (bars && bars[symbol]) || [];
        if (bars.length > 0) return bars.map(b => ({
          time: Math.floor(new Date(b.t).getTime() / 1000),
          open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
        }));
      } catch {}
      // Fallback: Yahoo Finance (free full history)
      console.log("Alpaca bars empty/unavailable - using Yahoo for", symbol);
      return yahooBars(symbol, timeframe);
    });
    res.json(candles);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, details: e.details });
  }
});

app.post("/api/orders", async (req, res) => {
  const { symbol, qty, side } = req.body;
  if (!symbol || !qty || !["buy", "sell"].includes(side))
    return res.status(400).json({ error: "Body needs: symbol, qty, side (buy|sell)" });
  try {
    res.status(201).json(await alpacaFetch("/v2/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: symbol.toUpperCase(), qty, side, type: "market", time_in_force: "day" }),
    }, userCreds(req)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

app.get("/api/positions", async (req, res) => {
  try {
    const uc = userCreds(req);
    const f = () => alpacaFetch("/v2/positions", {}, uc);
    res.json(uc ? await f() : await cached("pos", 10000, f));
  }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

app.get("/api/orders", async (req, res) => {
  try { res.json(await alpacaFetch("/v2/orders?status=all&limit=50", {}, userCreds(req))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

app.post("/api/orders/cancel-all", async (req, res) => {
  try { res.json(await alpacaFetch("/v2/orders", { method: "DELETE" }, userCreds(req))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

// ============ WEBSOCKET: live prices ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("tv") === "1") return tvProxy(socket, url);
  const symbols = (url.searchParams.get("symbols") || "AAPL").toUpperCase().split(",");
  console.log("Client subscribed:", symbols.join(", "));
  let i = 0;
  // FIX for Alpaca rate limits: fetch ONE symbol per tick, rotating through
  // the list. 3s x 11 symbols = ~20 requests/min per client (limit is 200).
  const interval = setInterval(async () => {
    if (socket.readyState !== socket.OPEN) return;
    const sym = symbols[i % symbols.length];
    i++;
    try {
      const q = await cached("q:" + sym, 10000, () => alpacaFetch(`/v2/stocks/${sym}/quotes/latest?feed=iex`));
      socket.send(JSON.stringify({
        symbol: sym,
        bid: q.quote?.bp, ask: q.quote?.ap,
        price: q.quote?.ap || q.quote?.bp,
        time: q.quote?.t,
      }));
    } catch (e) {
      if (e.status === 429) {
        // rate limited: wait extra 10s before next symbol
        i--;
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }, 3000);
  socket.on("close", () => clearInterval(interval));
});


// ================= SERVER-SIDE AI BOT — runs 24/7 in the cloud =================
// Armed by the "Enable AI bot" checkbox (botConfig.enabled) saved from the site.
function rsi14(cs){const o=[];let g=0,l=0;for(let i=1;i<cs.length;i++){const ch=cs[i].close-cs[i-1].close;
if(i<=14){g+=Math.max(ch,0);l+=Math.max(-ch,0);if(i===14)o.push({t:cs[i].time,v:100-100/(1+(l===0?100:g/l))});}
else{g=(g*13+Math.max(ch,0))/14;l=(l*13+Math.max(-ch,0))/14;o.push({t:cs[i].time,v:100-100/(1+(l===0?100:g/l))});}}return o;}
function emaS(cs,p){const o=[];const k=2/(p+1);let e=null;for(let i=0;i<cs.length;i++){e=cs[i].close*(i?k:1)+(e||cs[i].close)*(i?1-k:0);if(i>=p-1)o.push({t:cs[i].time,v:e});}return o;}
function macdS(cs){const f=emaS(cs,12),s=emaS(cs,26);return f.map((x,i)=>({t:x.t,v:x.v-(s[i]?s[i].v:0)})).slice(14);}
function atrS(cs,p=14){const o=[];let a=null;for(let i=1;i<cs.length;i++){const tr=Math.max(cs[i].high-cs[i].low,Math.abs(cs[i].high-cs[i-1].close),Math.abs(cs[i].low-cs[i-1].close));
a=a==null?tr:(a*(p-1)+tr)/p;if(i>=p)o.push({t:cs[i].time,v:a});}return o;}

const SBOT_STRATS = {
  "RSI Mean Reversion": cs=>{const r=rsi14(cs);if(r.length<2)return null;const v=r[r.length-1].v;
    if(v<30)return{side:"buy",reason:"RSI "+v.toFixed(1)+" oversold"};if(v>70)return{side:"sell",reason:"RSI "+v.toFixed(1)+" overbought"};return null;},
  "EMA Cross (9/21)": cs=>{const f=emaS(cs,9),s=emaS(cs,21);if(f.length<2||s.length<2)return null;
    const off=f.length-s.length,i=f.length-1,cur=f[i].v-s[i-off].v,prev=f[i-1].v-s[i-off-1]?.v;
    if(prev==null)return null;
    if(prev<=0&&cur>0)return{side:"buy",reason:"EMA9 crossed above EMA21"};
    if(prev>=0&&cur<0)return{side:"sell",reason:"EMA9 crossed below EMA21"};return null;},
  "MACD Crossover": cs=>{const m=macdS(cs);if(m.length<2)return null;const i=m.length-1;
    if(m[i].v>0&&m[i-1].v<=0)return{side:"buy",reason:"MACD crossed above zero"};
    if(m[i].v<0&&m[i-1].v>=0)return{side:"sell",reason:"MACD crossed below zero"};return null;},
  "Donchian Breakout (20)": cs=>{if(cs.length<21)return null;const last=cs[cs.length-1];
    const hh=Math.max(...cs.slice(-21,-1).map(c=>c.high)),ll=Math.min(...cs.slice(-21,-1).map(c=>c.low));
    if(last.close>hh)return{side:"buy",reason:"broke 20-bar high"};
    if(last.close<ll)return{side:"sell",reason:"broke 20-bar low"};return null;},
  "Momentum (RSI>55 + EMA20)": cs=>{const r=rsi14(cs),e=emaS(cs,20);if(!r.length||!e.length)return null;const last=cs[cs.length-1];
    if(r[r.length-1].v>55&&last.close>e[e.length-1].v)return{side:"buy",reason:"momentum aligned"};
    if(r[r.length-1].v<45&&last.close<e[e.length-1].v)return{side:"sell",reason:"downside momentum"};return null;},
};

const fcCache = new Map();
async function fetchCandles(symbol, tf) {
  const key = symbol + ":" + tf;
  const hit = fcCache.get(key);
  if (hit && Date.now() - hit.t < 30000) return hit.d;
  const d = await fetchCandlesRaw(symbol, tf);
  fcCache.set(key, { t: Date.now(), d });
  if (fcCache.size > 400) { const k0 = fcCache.keys().next().value; fcCache.delete(k0); }
  return d;
}
async function fetchCandlesRaw(symbol, tf) {
  try {
    const d = await alpacaFetch(`/v2/stocks/${symbol}/bars?timeframe=${tf}&limit=120&feed=iex`);
    let bars = d.bars; if (!Array.isArray(bars)) bars = (bars && bars[symbol]) || [];
    if (bars.length) return bars.map(b => ({ t: Math.floor(new Date(b.t).getTime()/1000), o:b.o,h:b.h,l:b.l,c:b.c }));
  } catch {}
  // Yahoo fallback
  const map = {"15Min":["15m","1mo"],"5Min":["5m","1mo"],"60Min":["60m","3mo"],"1Day":["1d","1y"]};
  const [iv,rg] = map[tf] || map["15Min"];
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${iv}&range=${rg}`,{headers:{"User-Agent":"Mozilla/5.0"}});
  const j = await res.json(); const r = j?.chart?.result?.[0]; if(!r) return [];
  const q = r.indicators?.quote?.[0] || {}; const out = [];
  for (let i=0;i<(r.timestamp||[]).length;i++){ if(q.open?.[i]==null)continue;
    out.push({t:r.timestamp[i],o:q.open[i],h:q.high[i],l:q.low[i],c:q.close[i]});}
  return out;
}
const sbotLog = m => { console.log("[BOT]", new Date().toISOString().slice(11,19), m); botTrades.push({event:"log",msg:m,serverTime:new Date().toISOString()}); };

setInterval(async () => {
  try {
    if (!botConfig.enabled) return;
    const strat = SBOT_STRATS[botConfig.strategy] || SBOT_STRATS["RSI Mean Reversion"];
    console.log("[BOT] cycle start — strategy:", botConfig.strategy, "| symbols:", (botConfig.symbols||[]).join(",") || "none");
    // 1) manage exits on open positions (SL/TP from config)
    let positions = [];
    try { positions = await alpacaFetch("/v2/positions"); } catch {}
    for (const p of positions) {
      const entry = parseFloat(p.avg_entry_price), cur = parseFloat(p.current_price);
      const qty = Math.abs(parseFloat(p.qty)); const long = parseFloat(p.qty) > 0;
      const pnlPct = (cur - entry) / entry * 100 * (long ? 1 : -1);
      if (pnlPct <= -botConfig.stopLossPct || pnlPct >= botConfig.takeProfitPct) {
        await alpacaFetch("/v2/orders", { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ symbol:p.symbol, qty, side: long?"sell":"buy", type:"market", time_in_force:"day" }) });
        sbotLog(`EXIT ${p.symbol} @ ${cur} (${pnlPct.toFixed(2)}%)`);
      }
    }
    console.log("[BOT] open positions:", positions.length, "| scanning", (botConfig.symbols||[]).length, "symbol(s)");
    if (positions.length >= botConfig.maxOpenPositions) return;
    // 2) scan for entries
    for (const sym of (botConfig.symbols || []).slice(0, 20)) {
      if (positions.some(p => p.symbol === sym)) continue;
      const cs = await fetchCandles(sym, "15Min");
      if (cs.length < 30) continue;
      const sig = strat(cs);
      if (!sig) continue;
      const price = cs[cs.length-1].c;
      const acc = await alpacaFetch("/v2/account");
      const equity = parseFloat(acc.equity);
      const dollars = botConfig.allocationType === "percent" ? equity * botConfig.allocationValue / 100 : botConfig.allocationValue;
      const qty = Math.max(1, Math.floor(dollars / price));
      await alpacaFetch("/v2/orders", { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ symbol:sym, qty, side:sig.side, type:"market", time_in_force:"day" }) });
      sbotLog(`ENTRY ${sig.side.toUpperCase()} ${qty} ${sym} @ ~${price.toFixed(2)} — ${sig.reason} [${botConfig.strategy}]`);
      botTrades.push({event:"entry",symbol:sym,side:sig.side,qty,price,reason:sig.reason,strategy:botConfig.strategy,serverTime:new Date().toISOString()});
      fs.writeFileSync(BTRADES_FILE, JSON.stringify(botTrades, null, 1));
      break; // one entry per cycle
    }
  } catch (e) { console.log("[BOT] cycle error:", e.message); }
}, 60000); // every 60 seconds, 24/7, even with every browser closed


// =====================================================================
// TRADOVATE CONNECTOR v2 - corrected endpoints + SockJS-style framing
// Docs: api.tradovate.com | Auth needs LIVE FUNDED acct + $25/mo API add-on
// (or a prop firm that enables it). appId/appVersion are FREE-FORM strings.
// Railway env vars:
//   TV_URL      default https://demo.tradovateapi.com/v1  (live: https://live.tradovateapi.com/v1)
//   TV_WS_MD    default wss://md.tradovateapi.com/v1/websocket
//   TV_WS_API   default wss://demo.tradovateapi.com/v1/websocket
//   TV_USER / TV_PASS          account login (or dedicated API password if set)
//   TV_APP_ID / TV_APP_VERSION free-form labels, e.g. SkyTraden / 1.0
//   TV_CID (number) / TV_SEC   from Application Settings > API Access
//   TV_DEVICE_ID  any unique label, e.g. skytraden-1
// =====================================================================
const TVCFG = {
  url: process.env.TV_URL || "https://demo.tradovateapi.com/v1",
  wsMd: process.env.TV_WS_MD || "wss://md.tradovateapi.com/v1/websocket",
  wsApi: process.env.TV_WS_API || "wss://demo.tradovateapi.com/v1/websocket",
  creds: { name: process.env.TV_USER || "", password: process.env.TV_PASS || "", appId: process.env.TV_APP_ID || "SkyTraden", appVersion: process.env.TV_APP_VERSION || "1.0", deviceId: process.env.TV_DEVICE_ID || "skytraden-1", cid: parseInt(process.env.TV_CID || "0", 10) || 0, sec: process.env.TV_SEC || "" },
};
const tvSessions = new Map();
async function tvAuth(sess){
  const s = tvSessions.get(sess) || {};
  if (s.token && Date.now() < new Date(s.exp).getTime() - 60000) return s.token;
  if (!TVCFG.creds.name || !TVCFG.creds.cid) throw new Error("Tradovate not configured - set TV_* env vars (needs live funded acct or prop firm with API + $25/mo add-on)");
  const r = await fetch(TVCFG.url + "/auth/accesstokenrequest", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(TVCFG.creds) });
  const d = await r.json();
  if (!r.ok || !d.accessToken) throw new Error(d.errorText || d.error || "Tradovate auth failed");
  s.token = d.accessToken; s.mdToken = d.mdAccessToken; s.exp = d.expirationTime;
  tvSessions.set(sess, s);
  return s.token;
}
app.get("/api/tv/status", async (req, res) => {
  try {
    if (!TVCFG.creds.name) return res.json({ ok: false, configured: false, msg: "Set TV_* env vars on Railway. Note: demo accounts cannot generate API keys - need live funded acct + API add-on, or a prop firm account with API enabled." });
    await tvAuth("default");
    res.json({ ok: true, configured: true, demo: TVCFG.url.includes("demo"), firm: process.env.TV_FIRM_NAME || null });
  } catch (e) { res.json({ ok: false, configured: true, error: e.message }); }
});

// ---- Tradovate WebSocket protocol (SockJS-inherited framing) ----
// Server sends: 'o' (open), 'h' (heartbeat every ~2.5s - reply '[]'), 'a[...]' (JSON array of messages), 'c[...]' (close)
// Client sends requests as JSON array: [endpoint, requestId, params]
function tvParseFrames(raw){
  const out = []; let T = "", payload = "";
  for (const msg of Array.isArray(raw) ? raw : [raw]){
    const s = msg.toString();
    T = s.slice(0, 1); payload = s.slice(1);
    if (T === "a" && payload) { try { JSON.parse(payload).forEach(m => out.push(m)); } catch {} }
    else if (T === "h" || T === "o") out.push({ _frame: T });
    else if (T === "c") out.push({ _frame: "c", reason: payload });
  }
  return out;
}

async function tvProxy(socket, url){
  let tv = null;
  try {
    const sess = await tvAuth("default").catch(() => null);
    const s = tvSessions.get("default");
    const syms = (url.searchParams.get("symbols") || "ES").toUpperCase().split(",");
    const WebSocketClient = require("ws").WebSocket;
    tv = new WebSocketClient(TVCFG.wsMd);
    await new Promise((res, rej) => { tv.on("open", res); tv.on("error", rej); });
    let rid = 1;
    const send = (endpoint, params) => tv.send(JSON.stringify([endpoint, rid++, params]));
    const contractIds = {};
    tv.on("message", raw => {
      tvParseFrames(raw).forEach(m => {
        if (m._frame === "h") { tv.send("[]"); return; }            // heartbeat reply
        if (m._frame) return;
        if (m.s === 200 && m.d && m.i && m.d.id) {                    // symbol/resolve response
          contractIds[m.i] = m.d.id;
          send("md/subscribeQuote", { symbols: Object.values(contractIds) });
        }
        if (m.d && m.d.quotes) m.d.quotes.forEach(q => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ tv: 1, contractId: q.contractId, price: q.price, bid: q.bid, ask: q.offer, ts: q.timestamp })); });
      });
    });
    send("authorize", { token: s.mdToken || s.token });
    syms.forEach(sym => send("symbol/resolve", { symbol: sym }));
    socket.on("close", () => { try { tv.close(); } catch {} });
  } catch (e) { try { socket.send(JSON.stringify({ tv: 1, error: e.message })); } catch {} }
}

app.post("/api/tv/order", async (req, res) => {
  try {
    const { action, contractId, qty } = req.body || {};
    const s = tvSessions.get("default") || {};
    await tvAuth("default");
    const WebSocketClient = require("ws").WebSocket;
    const tv = new WebSocketClient(TVCFG.wsApi);
    await new Promise((r, j) => { tv.on("open", r); tv.on("error", j); });
    let rid = 1; let accountId = null;
    const done = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timeout")), 12000);
      tv.on("message", raw => tvParseFrames(raw).forEach(m => {
        if (m._frame === "h") { tv.send("[]"); return; }
        if (m._frame || !m.s) return;
        if (m.s === 200 && m.d && Array.isArray(m.d) && m.d[0] && m.d[0].id && !accountId) {
          accountId = m.d[0].id;
          tv.send(JSON.stringify(["order/placeOrder", rid++, { accountId, contractId, action, orderQty: qty, orderType: "Market", timeInForce: { duration: "Day" }, isAutomated: true }]));
        } else if (m.s === 200 && m.d && (m.d.orderId || m.d.a)) { clearTimeout(to); resolve(m.d); }
        else if (m.e || (m.s && m.s >= 400)) { clearTimeout(to); reject(new Error(m.d || m.e || "order error")); }
      }));
    });
    tv.send(JSON.stringify(["authorize", rid++, { token: s.token }]));
    tv.send(JSON.stringify(["account/list", rid++, {}]));
    res.json({ ok: true, order: await done });
    tv.close();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

server.listen(PORT, () => {
  console.log(`Skytraden API running on port ${PORT} | Mode: ${process.env.ALPACA_ENV || "paper"}`);
});

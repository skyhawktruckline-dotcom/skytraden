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

async function alpacaFetch(path, options = {}) {
  // price/chart data -> data.alpaca.markets, trading -> paper/api.alpaca.markets
  const base = path.startsWith("/v2/stocks") ? DATA_URL : baseUrl();
  const res = await fetch(base + path, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": process.env.ALPACA_KEY,
      "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET,
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
app.options("*", (req, res) => res.sendStatus(204));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : true }));

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
  res.json({ token, username: u.username });
});

app.get("/api/me", (req, res) => {
  const u = sessions.get(req.headers["x-session"]);
  res.json({ username: u || null });
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

// ============ TRADING ROUTES ============
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", env: process.env.ALPACA_ENV || "paper", time: new Date().toISOString() }));

app.get("/api/account", async (req, res) => {
  try { res.json(await cached("acct", 10000, () => alpacaFetch("/v2/account"))); }
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
    let candles = await cached(`b:${symbol}:${timeframe}`, 60000, async () => {
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
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

app.get("/api/positions", async (req, res) => {
  try { res.json(await cached("pos", 10000, () => alpacaFetch("/v2/positions"))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

app.get("/api/orders", async (req, res) => {
  try { res.json(await alpacaFetch("/v2/orders?status=all&limit=50")); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

app.post("/api/orders/cancel-all", async (req, res) => {
  try { res.json(await alpacaFetch("/v2/orders", { method: "DELETE" })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, details: e.details }); }
});

// ============ WEBSOCKET: live prices ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
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

server.listen(PORT, () => {
  console.log(`Skytraden API running on port ${PORT} | Mode: ${process.env.ALPACA_ENV || "paper"}`);
});

// ─── AFK Creator Sniper Module ──────────────────────────────────────────────
// Monitors new pump.fun token launches via two detection modes:
//   PRIORITY: Direct RPC onLogs subscription per creator (fastest, ~0ms detection)
//   NORMAL:   PumpPortal WebSocket subscribeNewToken (slower, ~0.5-2s detection)
// When a watched creator deploys a new token → instant buy via PumpPortal trade-local API.
// Designed to run AFK on Railway.

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const bs58 = require("bs58");

// ─── Discord Webhook ─────────────────────────────────────────────────────────
const WEBHOOK_URL = (process.env.AFK_DISCORD_WEBHOOK || "").trim();
console.log(`[AFK] Discord webhook ${WEBHOOK_URL ? "loaded" : "NOT SET"}`);

const COLORS = { buy: 0x3fb950, info: 0x58a6ff, error: 0xf85149 };

async function sendDiscord(type, title, description, opts = {}) {
  if (!WEBHOOK_URL) return;
  const embed = {
    title: title.slice(0, 256),
    description: (description || "").slice(0, 4096),
    color: COLORS[type] || COLORS.info,
    timestamp: new Date().toISOString(),
  };
  if (opts.fields) embed.fields = opts.fields.slice(0, 25).map(f => ({
    name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: f.inline !== false,
  }));
  if (opts.url) embed.url = opts.url;

  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (resp.status === 429) {
      const data = await resp.json().catch(() => ({}));
      await new Promise(r => setTimeout(r, (data.retry_after || 1) * 1000));
      await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ embeds: [embed] }) });
    }
  } catch (err) {
    console.error(`[AFK] Discord error: ${err.message}`);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────
const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const STATE_FILE = path.join(__dirname, "afk-sniper-state.json");
const LOG_BUFFER_SIZE = 200;

// ─── State ───────────────────────────────────────────────────────────────────
let sniperRunning = false;
let ppWs = null;
let reconnectTimer = null;
let connection = null;
let keypair = null;
let launchesDetected = 0;
let buysExecuted = 0;
let buyHistory = [];
const boughtTokens = new Map();
const logBuffer = [];
const logSubscriptions = new Map(); // creatorAddr -> onLogs subscription ID

let broadcast = () => {};

// ─── Config ──────────────────────────────────────────────────────────────────
let config = {
  privateKey:        process.env.AFK_PRIVATE_KEY || "",
  rpcUrl:            process.env.AFK_RPC_URL || "",
  buyAmountSol:      parseFloat(process.env.AFK_BUY_AMOUNT_SOL || "0.1"),
  slippagePct:       parseFloat(process.env.AFK_SLIPPAGE_PCT || "25"),
  priorityFeeSol:    parseFloat(process.env.AFK_PRIORITY_FEE_SOL || "0.01"),
  dryRun:            (process.env.AFK_DRY_RUN || "true") === "true",
  priorityCreators:  (process.env.AFK_PRIORITY_CREATORS || "").split(",").map(s => s.trim()).filter(Boolean),
  watchedCreators:   (process.env.AFK_WATCHED_CREATORS || "").split(",").map(s => s.trim()).filter(Boolean),
};

// Fast O(1) lookup sets — rebuilt whenever config changes
let prioritySet = new Set(config.priorityCreators);
let watchedSet = new Set(config.watchedCreators);

function rebuildSets() {
  prioritySet = new Set(config.priorityCreators);
  watchedSet = new Set(config.watchedCreators);
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(type, msg) {
  const ts = new Date().toISOString();
  console.log(`[AFK ${ts}] ${msg}`);
  const entry = { type, msg, ts };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  broadcast(entry);
}

// ─── Persistent State ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data.boughtTokens) {
        for (const [k, v] of Object.entries(data.boughtTokens)) boughtTokens.set(k, v);
      }
      if (data.buyHistory) buyHistory = data.buyHistory;
      if (data.launchesDetected) launchesDetected = data.launchesDetected;
      if (data.buysExecuted) buysExecuted = data.buysExecuted;
    }
  } catch (err) {
    console.error("[AFK] Failed to load state:", err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      boughtTokens: Object.fromEntries(boughtTokens),
      buyHistory,
      launchesDetected,
      buysExecuted,
    }, null, 2));
  } catch (err) {
    console.error("[AFK] Failed to save state:", err.message);
  }
}

// ─── Execute Buy (PumpPortal trade-local) ─────────────────────────────────────
async function executeBuy(mint, creatorAddr, tokenName, tokenSymbol) {
  const buyCount = boughtTokens.get(mint) || 0;

  // Balance check + all-in adjustment
  let balance;
  try {
    balance = await connection.getBalance(keypair.publicKey);
  } catch (err) {
    log("error", `Balance check failed: ${err.message}`);
    return null;
  }
  const balanceSol = balance / LAMPORTS_PER_SOL;
  let buyAmount = config.buyAmountSol;

  const overhead = config.priorityFeeSol + 0.01;
  if (buyAmount + overhead > balanceSol) {
    const adjusted = balanceSol - overhead;
    if (adjusted <= 0) {
      log("error", `SKIP: Balance too low (${balanceSol.toFixed(4)} SOL)`);
      return null;
    }
    log("info", `All-in: adjusted buy from ${buyAmount} to ${adjusted.toFixed(4)} SOL`);
    buyAmount = parseFloat(adjusted.toFixed(4));
  }

  // Cap priority fee at 5% of balance
  let priorityFee = config.priorityFeeSol;
  const maxFeeBudget = balanceSol * 0.05;
  if (priorityFee > maxFeeBudget) {
    priorityFee = parseFloat(maxFeeBudget.toFixed(6));
    log("info", `Priority fee capped at ${priorityFee} SOL (5% of balance)`);
  }

  if (config.dryRun) {
    log("buy", `DRY RUN: Would buy ${tokenName || "?"} (${tokenSymbol || "?"}) — ${mint} with ${buyAmount} SOL`);
    boughtTokens.set(mint, buyCount + 1);
    buysExecuted++;
    buyHistory.unshift({
      token: mint, creator: creatorAddr, name: tokenName, symbol: tokenSymbol,
      buyCount: buyCount + 1, amountSol: buyAmount, txHash: "", dryRun: true, time: Date.now(),
    });
    saveState();
    sendDiscord("info", "DRY RUN: Would Snipe New Token", `**${tokenName}** (${tokenSymbol})`, {
      fields: [
        { name: "Mint", value: `\`${mint}\`` },
        { name: "Creator", value: `\`${creatorAddr}\`` },
        { name: "Amount", value: `${buyAmount} SOL` },
      ],
      url: `https://pump.fun/coin/${mint}`,
    });
    return { dryRun: true };
  }

  log("info", `BUYING ${tokenName || "?"} (${tokenSymbol || "?"}) — ${mint} with ${buyAmount} SOL (priority: ${priorityFee} SOL)...`);

  try {
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: keypair.publicKey.toBase58(),
        action: "buy",
        mint: mint,
        denominatedInSol: "true",
        amount: buyAmount,
        slippage: config.slippagePct,
        priorityFee: priorityFee,
        pool: "pump",
      }),
    });

    if (response.status !== 200) {
      const text = await response.text();
      log("error", `PumpPortal error (${response.status}): ${text}`);
      return null;
    }

    const data = await response.arrayBuffer();
    const tx = VersionedTransaction.deserialize(new Uint8Array(data));
    tx.sign([keypair]);

    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    log("buy", `TX sent: ${sig}`);
    log("info", "Waiting for confirmation...");

    const confirmation = await connection.confirmTransaction(sig, "confirmed");
    if (confirmation.value.err) {
      log("error", `TX failed: ${JSON.stringify(confirmation.value.err)}`);
      return null;
    }

    log("buy", `TX confirmed: ${sig}`);
    log("buy", `Solscan: https://solscan.io/tx/${sig}`);

    boughtTokens.set(mint, buyCount + 1);
    buysExecuted++;
    buyHistory.unshift({
      token: mint, creator: creatorAddr, name: tokenName, symbol: tokenSymbol,
      buyCount: buyCount + 1, amountSol: buyAmount, txHash: sig, dryRun: false, time: Date.now(),
    });
    saveState();

    sendDiscord("buy", "Sniped New Token Launch!", `**${tokenName}** (${tokenSymbol})`, {
      fields: [
        { name: "Mint", value: `\`${mint}\`` },
        { name: "Creator", value: `\`${creatorAddr}\`` },
        { name: "Amount", value: `${buyAmount} SOL` },
        { name: "TX", value: `[Solscan](https://solscan.io/tx/${sig})` },
      ],
      url: `https://pump.fun/coin/${mint}`,
    });

    return { txHash: sig };
  } catch (err) {
    log("error", `Buy failed: ${err.message}`);
    return null;
  }
}

// ─── Priority Mode: Parse pump.fun Create event from onLogs ──────────────────
// Pump.fun CreateEvent layout (borsh):
//   disc(8) + name(4+N) + symbol(4+N) + uri(4+N) + mint(32) + bondingCurve(32) + user(32)
function parseCreateEvent(logs) {
  for (const logLine of logs) {
    if (!logLine.startsWith("Program data: ")) continue;
    try {
      const data = Buffer.from(logLine.slice(14), "base64");
      if (data.length < 50) continue;

      let offset = 8; // skip event discriminator

      // Read name string (4-byte LE length + utf8)
      if (offset + 4 > data.length) continue;
      const nameLen = data.readUInt32LE(offset);
      offset += 4;
      if (nameLen > 200 || offset + nameLen > data.length) continue;
      const name = data.slice(offset, offset + nameLen).toString("utf-8");
      offset += nameLen;

      // Read symbol string
      if (offset + 4 > data.length) continue;
      const symbolLen = data.readUInt32LE(offset);
      offset += 4;
      if (symbolLen > 50 || offset + symbolLen > data.length) continue;
      const symbol = data.slice(offset, offset + symbolLen).toString("utf-8");
      offset += symbolLen;

      // Read uri string
      if (offset + 4 > data.length) continue;
      const uriLen = data.readUInt32LE(offset);
      offset += 4;
      if (uriLen > 500 || offset + uriLen > data.length) continue;
      offset += uriLen; // skip uri content

      // Read mint (32 bytes)
      if (offset + 32 > data.length) continue;
      const mint = new PublicKey(data.slice(offset, offset + 32)).toBase58();

      return { mint, name, symbol };
    } catch {
      continue;
    }
  }
  return null;
}

// Handle onLogs event for a priority creator
async function handlePriorityLog(logInfo, creatorAddr) {
  if (!sniperRunning) return;
  if (logInfo.err) return;

  const { signature, logs } = logInfo;

  // Quick filter: is pump.fun program involved?
  if (!logs.some(l => l.includes(PUMP_PROGRAM))) return;

  // Is this a create instruction?
  if (!logs.some(l => l.includes("Instruction: Create"))) return;

  log("claim", `PRIORITY MATCH: Creator ${creatorAddr} — pump.fun create TX!`);
  log("info", `  TX: ${signature}`);

  // Try fast path: parse mint directly from log event data (no extra RPC call)
  const event = parseCreateEvent(logs);

  if (event && event.mint) {
    log("info", `  Parsed from logs: ${event.name} (${event.symbol}) — ${event.mint}`);
    log("info", `  Pump.fun: https://pump.fun/coin/${event.mint}`);
    launchesDetected++;
    try {
      await executeBuy(event.mint, creatorAddr, event.name, event.symbol);
    } catch (err) {
      log("error", `Error executing buy: ${err.message}`);
    }
    return;
  }

  // Fallback: fetch full transaction to extract mint from accounts
  log("info", "  Log parsing failed, fetching TX for mint...");
  try {
    await new Promise(r => setTimeout(r, 500));
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      log("error", `  Could not fetch TX ${signature}`);
      return;
    }

    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys || msg.accountKeys;

    for (const ix of (msg.compiledInstructions || [])) {
      const progKey = keys[ix.programIdIndex];
      if (progKey && progKey.toBase58() === PUMP_PROGRAM && ix.accountKeyIndexes.length > 0) {
        const mint = keys[ix.accountKeyIndexes[0]].toBase58();
        log("info", `  Extracted mint from TX: ${mint}`);
        log("info", `  Pump.fun: https://pump.fun/coin/${mint}`);
        launchesDetected++;
        await executeBuy(mint, creatorAddr, null, null);
        return;
      }
    }

    log("error", `  Could not find mint in TX ${signature}`);
  } catch (err) {
    log("error", `  TX fetch failed: ${err.message}`);
  }
}

// ─── Process New Token Event (PumpPortal — normal mode) ───────────────────────
async function processNewToken(tokenData) {
  const creator = tokenData.traderPublicKey;
  if (!creator) return;

  // Skip if already handled by priority (direct RPC) mode
  if (prioritySet.has(creator)) return;

  // O(1) set lookup — speed is everything
  if (!watchedSet.has(creator)) return;

  const mint = tokenData.mint;
  if (!mint) return;

  launchesDetected++;
  const name = tokenData.name || "Unknown";
  const symbol = tokenData.symbol || "???";

  log("claim", `MATCH! Creator ${creator} launched ${name} (${symbol})`);
  log("info", `  Mint: ${mint}`);
  log("info", `  Pump.fun: https://pump.fun/coin/${mint}`);

  try {
    await executeBuy(mint, creator, name, symbol);
  } catch (err) {
    log("error", `Error executing buy: ${err.message}`);
  }
}

// ─── PumpPortal WebSocket ────────────────────────────────────────────────────
function connectPumpPortal() {
  if (ppWs) {
    try { ppWs.close(); } catch {}
    ppWs = null;
  }

  log("info", "Connecting to PumpPortal WebSocket...");

  ppWs = new WebSocket(PUMPPORTAL_WS);

  ppWs.on("open", () => {
    log("info", "Connected to PumpPortal WebSocket");
    ppWs.send(JSON.stringify({ method: "subscribeNewToken" }));
    log("info", `Subscribed to new token events — watching ${watchedSet.size} creator(s)`);
  });

  ppWs.on("message", (data) => {
    if (!sniperRunning) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.mint && msg.traderPublicKey) {
        processNewToken(msg).catch(err => {
          log("error", `Error processing token ${msg.mint}: ${err.message}`);
        });
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ppWs.on("close", () => {
    log("info", "PumpPortal WebSocket disconnected");
    if (sniperRunning) {
      log("info", "Reconnecting in 5s...");
      reconnectTimer = setTimeout(connectPumpPortal, 5000);
    }
  });

  ppWs.on("error", (err) => {
    log("error", `PumpPortal WebSocket error: ${err.message}`);
  });
}

// ─── Start / Stop ────────────────────────────────────────────────────────────
async function startSniper() {
  if (sniperRunning) throw new Error("AFK Sniper is already running");
  if (!config.privateKey) throw new Error("Private key not configured. Set AFK_PRIVATE_KEY env var.");
  if (!config.rpcUrl) throw new Error("RPC URL not configured. Set AFK_RPC_URL env var.");

  const totalCreators = config.priorityCreators.length + config.watchedCreators.length;
  if (totalCreators === 0) throw new Error("No creators configured. Add priority or watched creators.");

  log("info", "=== AFK Creator Sniper Starting ===");
  log("info", `RPC: ${config.rpcUrl.replace(/api-key=[^&]+/, "api-key=***")}`);
  log("info", `Buy: ${config.buyAmountSol} SOL | Slippage: ${config.slippagePct}% | Priority Fee: ${config.priorityFeeSol} SOL`);
  log("info", `Dry Run: ${config.dryRun}`);
  log("info", `Priority Creators (direct RPC): ${config.priorityCreators.length}`);
  log("info", `Watched Creators (PumpPortal):  ${config.watchedCreators.length}`);

  // Parse keypair
  try {
    const secretKey = bs58.decode(config.privateKey);
    keypair = Keypair.fromSecretKey(secretKey);
  } catch {
    throw new Error("Invalid private key (must be base58 Solana secret key)");
  }

  // Connect to Solana RPC
  const wsUrl = config.rpcUrl.replace(/^https?/, "wss");
  connection = new Connection(config.rpcUrl, {
    wsEndpoint: wsUrl,
    commitment: "confirmed",
  });

  const balance = await connection.getBalance(keypair.publicKey);
  log("info", `Wallet: ${keypair.publicKey.toBase58()}`);
  log("info", `Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  if (balance === 0) log("error", "WARNING: Wallet has 0 SOL — buys will fail");

  rebuildSets();
  sniperRunning = true;

  // ── Priority creators: direct RPC onLogs subscriptions (fastest) ──
  if (config.priorityCreators.length > 0) {
    log("info", "Setting up direct RPC subscriptions for priority creators...");
    for (const creatorAddr of config.priorityCreators) {
      try {
        const creatorPubkey = new PublicKey(creatorAddr);
        const subId = connection.onLogs(
          creatorPubkey,
          (logInfo) => {
            handlePriorityLog(logInfo, creatorAddr).catch(err => {
              log("error", `Priority handler error: ${err.message}`);
            });
          },
          "confirmed"
        );
        logSubscriptions.set(creatorAddr, subId);
        log("info", `  [DIRECT RPC] ${creatorAddr}`);
      } catch (err) {
        log("error", `  Failed to subscribe to ${creatorAddr}: ${err.message}`);
      }
    }
    log("info", `${logSubscriptions.size} direct RPC subscription(s) active`);
  }

  // ── Watched creators: PumpPortal WebSocket (normal mode) ──
  if (config.watchedCreators.length > 0) {
    for (const c of config.watchedCreators) {
      log("info", `  [PUMPPORTAL] ${c}`);
    }
    connectPumpPortal();
  } else {
    log("info", "No PumpPortal creators — skipping WebSocket connection");
  }
}

function stopSniper() {
  sniperRunning = false;

  // Clean up direct RPC subscriptions
  for (const [addr, subId] of logSubscriptions) {
    try { connection.removeOnLogsListener(subId); } catch {}
  }
  logSubscriptions.clear();

  // Clean up PumpPortal WebSocket
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ppWs) {
    try { ppWs.close(); } catch {}
    ppWs = null;
  }
  log("info", "AFK Sniper stopped");
  saveState();
}

// ─── Exports ─────────────────────────────────────────────────────────────────
function init(broadcastFn) {
  broadcast = broadcastFn;
  loadState();
}

function getStatus() {
  let walletAddr = "";
  let balanceSol = "";
  if (keypair) walletAddr = keypair.publicKey.toBase58();
  return {
    running: sniperRunning,
    wallet: walletAddr,
    balance: balanceSol,
    launchesDetected,
    buysExecuted,
    priorityCreators: config.priorityCreators.length,
    watchedCreators: config.watchedCreators.length,
  };
}

async function refreshBalance() {
  if (!keypair || !connection) return "";
  try {
    const bal = await connection.getBalance(keypair.publicKey);
    return (bal / LAMPORTS_PER_SOL).toFixed(4);
  } catch {
    return "";
  }
}

function getLogBuffer() { return logBuffer; }

function getConfig() {
  const masked = { ...config };
  if (masked.privateKey) {
    masked.privateKey = masked.privateKey.slice(0, 6) + "..." + masked.privateKey.slice(-4);
  }
  if (masked.rpcUrl && masked.rpcUrl.includes("api-key=")) {
    masked.rpcUrl = masked.rpcUrl.replace(/api-key=[^&]+/, "api-key=***");
  }
  return masked;
}

function updateConfig(body) {
  if (body.privateKey !== undefined) config.privateKey = body.privateKey;
  if (body.rpcUrl !== undefined) config.rpcUrl = body.rpcUrl;
  if (body.buyAmountSol !== undefined) config.buyAmountSol = parseFloat(body.buyAmountSol);
  if (body.slippagePct !== undefined) config.slippagePct = parseFloat(body.slippagePct);
  if (body.priorityFeeSol !== undefined) config.priorityFeeSol = parseFloat(body.priorityFeeSol);
  if (body.dryRun !== undefined) config.dryRun = body.dryRun === true || body.dryRun === "true";
  if (body.priorityCreators !== undefined) {
    config.priorityCreators = Array.isArray(body.priorityCreators)
      ? body.priorityCreators
      : body.priorityCreators.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }
  if (body.watchedCreators !== undefined) {
    config.watchedCreators = Array.isArray(body.watchedCreators)
      ? body.watchedCreators
      : body.watchedCreators.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }
  rebuildSets();
  log("info", `Config updated — ${config.priorityCreators.length} priority + ${config.watchedCreators.length} watched creator(s)`);
}

function getHistory() { return buyHistory; }

module.exports = {
  init, startSniper, stopSniper,
  getStatus, refreshBalance, getLogBuffer, getConfig, updateConfig, getHistory,
};

// ─── Four.Meme Agent Sniper Module ──────────────────────────────────────────
// Monitors TokenManager2 on BSC for new token launches.
// Agent wallet (8004 NFT holder) can buy during insider phase before public.
// Discord notifications for all new launches + snipe alerts.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ─── Contract Addresses (BSC) ────────────────────────────────────────────────
const TOKEN_MANAGER2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b";
const HELPER3 = "0xF251F83e40a78868FcfA3FA4599Dad6494E46034";
const NFT_8004 = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const TM2_ABI = [
  "event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)",
  "function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable",
  "function buyToken(address token, uint256 amount, uint256 maxFunds) payable",
];

const HELPER3_ABI = [
  "function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)",
  "function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)",
];

const NFT_8004_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
];

// ─── Discord Webhook ─────────────────────────────────────────────────────────
const WEBHOOK_URL = (process.env.FOURMEME_DISCORD_WEBHOOK || "https://discord.com/api/webhooks/1478830999042396443/d0ZuvTov094UbvWxd4uZYIZtzlu1-wfzs2-8_Cp4AlWd1XM7YfYfHFjf_5K_TtncfcBt").trim();
console.log(`[4MEME] Discord webhook ${WEBHOOK_URL ? "loaded" : "NOT SET"}`);

const COLORS = { launch: 0xa371f7, agent: 0xf0883e, buy: 0x3fb950, info: 0x58a6ff, error: 0xf85149 };

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
  if (opts.footer) embed.footer = { text: opts.footer };
  if (opts.thumbnail) embed.thumbnail = { url: opts.thumbnail };

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
    console.error(`[4MEME] Discord error: ${err.message}`);
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, "fourmeme-sniper-state.json");
const LOG_BUFFER_SIZE = 200;

// ─── State ───────────────────────────────────────────────────────────────────
let sniperRunning = false;
let pollTimer = null;
let provider = null;
let wallet = null;
let tm2Contract = null;
let helperContract = null;
let nftContract = null;
let lastBlock = 0;
let tokensDetected = 0;
let agentTokensDetected = 0;
let buysExecuted = 0;
let buyHistory = [];
const boughtTokens = new Map();
const logBuffer = [];

let broadcast = () => {};

// ─── Config ──────────────────────────────────────────────────────────────────
let config = {
  privateKey:      process.env.FOURMEME_PRIVATE_KEY || "",
  rpcUrl:          process.env.FOURMEME_RPC_URL || "https://bsc-dataseed1.binance.org",
  buyAmountBnb:    process.env.FOURMEME_BUY_AMOUNT_BNB || "0.01",
  slippagePct:     parseFloat(process.env.FOURMEME_SLIPPAGE_PCT || "25"),
  pollIntervalMs:  parseInt(process.env.FOURMEME_POLL_INTERVAL_MS || "3000", 10),
  dryRun:          (process.env.FOURMEME_DRY_RUN || "true") === "true",
  watchedCreators: (process.env.FOURMEME_WATCHED_CREATORS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
};

let watchedSet = new Set(config.watchedCreators);

function rebuildWatchedSet() {
  watchedSet = new Set(config.watchedCreators.map(s => s.toLowerCase()));
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(type, msg) {
  const ts = new Date().toISOString();
  console.log(`[4MEME ${ts}] ${msg}`);
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
      if (data.lastBlock) lastBlock = data.lastBlock;
      if (data.boughtTokens) {
        for (const [k, v] of Object.entries(data.boughtTokens)) boughtTokens.set(k, v);
      }
      if (data.buyHistory) buyHistory = data.buyHistory;
      if (data.tokensDetected) tokensDetected = data.tokensDetected;
      if (data.agentTokensDetected) agentTokensDetected = data.agentTokensDetected;
      if (data.buysExecuted) buysExecuted = data.buysExecuted;
    }
  } catch (err) {
    console.error("[4MEME] Failed to load state:", err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastBlock,
      boughtTokens: Object.fromEntries(boughtTokens),
      buyHistory,
      tokensDetected,
      agentTokensDetected,
      buysExecuted,
    }, null, 2));
  } catch (err) {
    console.error("[4MEME] Failed to save state:", err.message);
  }
}

// ─── Check if creator is an agent (has 8004 NFT) ────────────────────────────
async function isAgentWallet(address) {
  try {
    const balance = await nftContract.balanceOf(address);
    return balance > 0n;
  } catch {
    return false;
  }
}

// ─── Execute Buy ─────────────────────────────────────────────────────────────
async function executeBuy(tokenAddress, creatorAddress, tokenName, tokenSymbol, isAgent) {
  const tokenLower = tokenAddress.toLowerCase();
  if (boughtTokens.has(tokenLower)) {
    log("skip", `SKIP: Already bought ${tokenName} (${tokenSymbol})`);
    return null;
  }

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  const balanceBnb = parseFloat(ethers.formatEther(balance));
  let buyAmount = parseFloat(config.buyAmountBnb);

  const overhead = 0.002; // gas overhead
  if (buyAmount + overhead > balanceBnb) {
    const adjusted = balanceBnb - overhead;
    if (adjusted <= 0) {
      log("error", `SKIP: Balance too low (${balanceBnb.toFixed(4)} BNB)`);
      return null;
    }
    log("info", `All-in: adjusted buy from ${buyAmount} to ${adjusted.toFixed(4)} BNB`);
    buyAmount = parseFloat(adjusted.toFixed(4));
  }

  const fundsWei = ethers.parseEther(buyAmount.toString());

  if (config.dryRun) {
    log("buy", `DRY RUN: Would buy ${tokenName} (${tokenSymbol}) — ${tokenAddress} with ${buyAmount} BNB`);
    boughtTokens.set(tokenLower, { time: Date.now(), dryRun: true });
    buysExecuted++;
    buyHistory.unshift({
      token: tokenAddress, creator: creatorAddress, name: tokenName, symbol: tokenSymbol,
      amountBnb: buyAmount, txHash: "", dryRun: true, isAgent, time: Date.now(),
    });
    saveState();
    sendDiscord("buy", `\u{1f9ea} DRY RUN: ${tokenName} (${tokenSymbol})`, `Would buy **${tokenName}** (${tokenSymbol}) with ${buyAmount} BNB`, {
      fields: [
        { name: "\u{1fa99} Token", value: `**${tokenName}** (${tokenSymbol})`, inline: false },
        { name: "\u{1f4cd} Contract", value: `\`${tokenAddress}\``, inline: false },
        { name: "\u{1f4b0} Amount", value: `${buyAmount} BNB` },
        { name: "\u{1f50d} Links", value: `[Four.Meme](https://four.meme/token/${tokenAddress}) \u2022 [BscScan](https://bscscan.com/token/${tokenAddress})`, inline: false },
        { name: "\u{1f4cb} Quick Copy", value: `\`\`\`${tokenAddress}\`\`\``, inline: false },
      ],
      url: `https://four.meme/token/${tokenAddress}`,
      footer: "\u25ce BNB",
    });
    return { dryRun: true };
  }

  log("info", `BUYING ${tokenName} (${tokenSymbol}) — ${tokenAddress} with ${buyAmount} BNB...`);

  try {
    // Get quote via Helper3
    const tryBuyResult = await helperContract.tryBuy(tokenAddress, 0n, fundsWei);
    const tokenManager = tryBuyResult[0];
    const quote = tryBuyResult[1];
    const estimatedAmount = tryBuyResult[2];
    const amountMsgValue = tryBuyResult[5];
    const amountApproval = tryBuyResult[6];

    log("info", `  Estimated tokens: ${ethers.formatEther(estimatedAmount)}`);

    // Apply slippage
    const slippageBps = BigInt(Math.round(config.slippagePct * 100));
    const minAmount = estimatedAmount * (10000n - slippageBps) / 10000n;

    // If quote is ERC20 (not native BNB), approve first
    if (quote !== ZERO_ADDRESS && amountApproval > 0n) {
      log("info", "  Approving quote token...");
      const erc20 = new ethers.Contract(quote, ERC20_ABI, wallet);
      const approveTx = await erc20.approve(tokenManager, amountApproval);
      await approveTx.wait();
      log("info", "  Approved");
    }

    // Execute buy
    const tm2 = new ethers.Contract(tokenManager, TM2_ABI, wallet);
    const tx = await tm2.buyTokenAMAP(tokenAddress, fundsWei, minAmount, {
      value: amountMsgValue,
    });
    log("buy", `TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log("buy", `TX confirmed in block ${receipt.blockNumber}`);
    log("buy", `BscScan: https://bscscan.com/tx/${tx.hash}`);

    boughtTokens.set(tokenLower, { time: Date.now(), txHash: tx.hash });
    buysExecuted++;
    buyHistory.unshift({
      token: tokenAddress, creator: creatorAddress, name: tokenName, symbol: tokenSymbol,
      amountBnb: buyAmount, txHash: tx.hash, dryRun: false, isAgent, time: Date.now(),
    });
    saveState();

    sendDiscord("buy", `\u2705 Sniped: ${tokenName} (${tokenSymbol})`, `Bought **${tokenName}** (${tokenSymbol}) for ${buyAmount} BNB`, {
      fields: [
        { name: "\u{1fa99} Token", value: `**${tokenName}** (${tokenSymbol})`, inline: false },
        { name: "\u{1f4cd} Contract", value: `\`${tokenAddress}\``, inline: false },
        { name: "\u{1f4b0} Amount", value: `${buyAmount} BNB` },
        { name: "\u{1f4ca} Tokens", value: `~${ethers.formatEther(estimatedAmount)}` },
        { name: "\u{1f50d} Links", value: `[Four.Meme](https://four.meme/token/${tokenAddress}) \u2022 [BscScan](https://bscscan.com/tx/${tx.hash})`, inline: false },
        { name: "\u{1f4cb} Quick Copy", value: `\`\`\`${tokenAddress}\`\`\``, inline: false },
      ],
      url: `https://four.meme/token/${tokenAddress}`,
      footer: "\u25ce BNB",
    });

    return { txHash: tx.hash };
  } catch (err) {
    log("error", `Buy failed: ${err.message}`);
    return null;
  }
}

// ─── Process TokenCreate Event ───────────────────────────────────────────────
async function processTokenCreate(event) {
  const creator = event.args[0];
  const token = event.args[1];
  const name = event.args[3];
  const symbol = event.args[4];

  tokensDetected++;

  log("claim", `NEW TOKEN: ${name} (${symbol})`);
  log("info", `  Token: ${token}`);
  log("info", `  Creator: ${creator}`);
  log("info", `  Four.Meme: https://four.meme/token/${token}`);

  // ── Agent check runs in background, never blocks buy path ──
  isAgentWallet(creator).then(async (isAgent) => {
    if (!isAgent) return;
    agentTokensDetected++;
    log("info", `  [AGENT] ${name} (${symbol}) — creator holds 8004 NFT`);

    // Fetch token image from Four.Meme API
    let imageUrl = null;
    try {
      const resp = await fetch(`https://four.meme/meme-api/v1/public/token/info?address=${token}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.data?.image) imageUrl = data.data.image;
      }
    } catch {}

    sendDiscord("agent",
      `\uD83E\uDD16 Agent Token on Four.Meme`,
      `**${name}** (${symbol}) launched by an AI Agent`, {
      fields: [
        { name: "\uD83E\uDE99 Token", value: `**${name}** (${symbol})`, inline: false },
        { name: "\uD83D\uDCCD Contract", value: `\`${token}\``, inline: false },
        { name: "\uD83D\uDC64 Creator", value: `\`${creator}\``, inline: false },
        { name: "\uD83D\uDD0D Links", value: `[Four.Meme](https://four.meme/token/${token}) \u2022 [BscScan](https://bscscan.com/token/${token})`, inline: false },
        { name: "\uD83D\uDCCB Quick Copy", value: `\`\`\`${token}\`\`\``, inline: false },
      ],
      url: `https://four.meme/token/${token}`,
      footer: "\u25CE BNB",
      thumbnail: imageUrl,
    });
  }).catch(() => {});

  // ── Buy decision: only if creator is on watched list (instant, no RPC) ──
  if (watchedSet.size === 0) return;

  if (!watchedSet.has(creator.toLowerCase())) {
    log("skip", `  SKIP: Creator not on watched list`);
    return;
  }

  log("info", "  MATCH: Creator is on watched list — buying");

  try {
    await executeBuy(token, creator, name, symbol, false);
  } catch (err) {
    log("error", `Error executing buy: ${err.message}`);
  }
}

// ─── WebSocket Event Subscription (near-instant detection) ──────────────────
let wsProvider = null;
let wsTm2 = null;

function rpcToWs(rpcUrl) {
  return rpcUrl.replace(/^https?:\/\//, "wss://");
}

async function setupEventListener() {
  const wsUrl = rpcToWs(config.rpcUrl);
  log("info", `Connecting WebSocket to ${wsUrl.replace(/\/v2\/.*/, "/v2/***")}...`);

  try {
    wsProvider = new ethers.WebSocketProvider(wsUrl);
    wsTm2 = new ethers.Contract(TOKEN_MANAGER2, TM2_ABI, wsProvider);

    await wsTm2.on("TokenCreate", async (creator, token, requestId, name, symbol, totalSupply, launchTime, launchFee, event) => {
      if (!sniperRunning) return;
      try {
        const blockNum = event.log.blockNumber;
        log("info", `TokenCreate detected in block ${blockNum} (LIVE via WSS)`);
        lastBlock = blockNum;
        await processTokenCreate({
          args: [creator, token, requestId, name, symbol, totalSupply, launchTime, launchFee],
          transactionHash: event.log.transactionHash,
        });
        saveState();
      } catch (err) {
        log("error", `Error processing token: ${err.message}`);
      }
    });

    wsProvider.websocket.on("close", () => {
      if (!sniperRunning) return;
      log("error", "BSC WebSocket disconnected — reconnecting in 5s...");
      teardownEventListener();
      setTimeout(async () => {
        if (!sniperRunning) return;
        const ok = await setupEventListener();
        if (!ok) {
          log("error", "WSS reconnect failed — falling back to polling");
          startPolling();
        }
      }, 5000);
    });

    wsProvider.websocket.on("error", (err) => {
      log("error", `BSC WebSocket error: ${err.message}`);
    });

    log("info", "Live event subscription active (near-instant detection)");
    return true;
  } catch (err) {
    log("error", `WebSocket subscription failed: ${err.message}`);
    log("info", "Falling back to polling mode");
    return false;
  }
}

function teardownEventListener() {
  if (wsTm2) {
    wsTm2.removeAllListeners();
    wsTm2 = null;
  }
  if (wsProvider) {
    wsProvider.destroy();
    wsProvider = null;
  }
}

// ─── Polling Fallback ───────────────────────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  log("info", `Polling fallback active (every ${config.pollIntervalMs}ms)`);
  pollTimer = setTimeout(pollOnce, config.pollIntervalMs);
}

async function pollOnce() {
  if (!sniperRunning) return;

  try {
    const currentBlock = await provider.getBlockNumber();

    if (currentBlock > lastBlock) {
      const fromBlock = lastBlock + 1;
      const toBlock = Math.min(currentBlock, fromBlock + 49);

      const tm2 = new ethers.Contract(TOKEN_MANAGER2, TM2_ABI, provider);
      const filter = tm2.filters.TokenCreate();
      const events = await tm2.queryFilter(filter, fromBlock, toBlock);

      if (events.length > 0) {
        log("info", `Found ${events.length} new token(s) in blocks ${fromBlock}-${toBlock}`);
      }

      for (const event of events) {
        try {
          await processTokenCreate(event);
        } catch (err) {
          log("error", `Error processing token: ${err.message}`);
        }
      }

      lastBlock = toBlock;
      if (tokensDetected % 10 === 0 && tokensDetected > 0) saveState();
    }
  } catch (err) {
    if (err.message && err.message.includes("rate limit")) {
      log("skip", "RPC rate limited, backing off...");
    } else {
      log("error", `Poll error: ${err.message}`);
    }
  }

  if (sniperRunning) {
    pollTimer = setTimeout(pollOnce, config.pollIntervalMs);
  }
}

// ─── Start / Stop ────────────────────────────────────────────────────────────
async function startSniper() {
  if (sniperRunning) throw new Error("Four.Meme sniper is already running");
  if (!config.privateKey) throw new Error("Private key not configured. Set FOURMEME_PRIVATE_KEY env var.");

  log("info", "=== Four.Meme Agent Sniper Starting ===");
  log("info", `RPC: ${config.rpcUrl}`);
  log("info", `Buy: ${config.buyAmountBnb} BNB | Slippage: ${config.slippagePct}%`);
  log("info", `Dry Run: ${config.dryRun}`);
  log("info", `Mode: Notify agent tokens + Buy watched creators only`);
  if (config.watchedCreators.length > 0) {
    log("info", `Watched Creators: ${config.watchedCreators.length}`);
  }

  provider = new ethers.JsonRpcProvider(config.rpcUrl);

  const pk = config.privateKey.startsWith("0x") ? config.privateKey : "0x" + config.privateKey;
  wallet = new ethers.Wallet(pk, provider);

  const balance = await provider.getBalance(wallet.address);
  log("info", `Wallet: ${wallet.address}`);
  log("info", `Balance: ${ethers.formatEther(balance)} BNB`);

  if (balance === 0n) log("error", "WARNING: Wallet has 0 BNB — buys will fail");

  // Check 8004 NFT status
  nftContract = new ethers.Contract(NFT_8004, NFT_8004_ABI, provider);
  const nftBalance = await nftContract.balanceOf(wallet.address);
  if (nftBalance > 0n) {
    log("info", `Agent Status: VERIFIED (8004 NFT balance: ${nftBalance})`);
  } else {
    log("error", "WARNING: No 8004 NFT — cannot buy during insider phase");
  }

  // Set up contracts
  helperContract = new ethers.Contract(HELPER3, HELPER3_ABI, provider);

  rebuildWatchedSet();

  if (!lastBlock) {
    lastBlock = await provider.getBlockNumber();
    log("info", `Starting from block ${lastBlock}`);
  } else {
    log("info", `Resuming from block ${lastBlock}`);
  }

  sniperRunning = true;
  log("info", "Listening for TokenCreate events on TokenManager2...");

  // Try WebSocket subscription first, fall back to polling
  const wsOk = await setupEventListener();
  if (!wsOk) {
    startPolling();
  }

  sendDiscord("info", "Four.Meme Sniper Started", `Monitoring BSC for new token launches`, {
    fields: [
      { name: "Wallet", value: `\`${wallet.address}\`` },
      { name: "Balance", value: `${ethers.formatEther(balance)} BNB` },
      { name: "Agent NFT", value: nftBalance > 0n ? "Verified" : "None" },
      { name: "Mode", value: config.dryRun ? "DRY RUN" : "LIVE" },
      { name: "Detection", value: wsOk ? "WebSocket (instant)" : "Polling (3s)" },
    ],
    footer: "BNB Chain | Four.Meme",
  });
}

function stopSniper() {
  sniperRunning = false;
  teardownEventListener();
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  log("info", "Four.Meme sniper stopped");
  saveState();
}

// ─── Exports ─────────────────────────────────────────────────────────────────
function init(broadcastFn) {
  broadcast = broadcastFn;
  loadState();
}

function getStatus() {
  let walletAddr = "";
  let balanceBnb = "";
  if (wallet) walletAddr = wallet.address;
  return {
    running: sniperRunning,
    wallet: walletAddr,
    balance: balanceBnb,
    tokensDetected,
    agentTokensDetected,
    buysExecuted,
    block: lastBlock,
  };
}

async function refreshBalance() {
  if (!wallet || !provider) return "";
  try {
    const bal = await provider.getBalance(wallet.address);
    return ethers.formatEther(bal);
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
  return masked;
}

function updateConfig(body) {
  if (body.privateKey !== undefined) config.privateKey = body.privateKey;
  if (body.rpcUrl !== undefined) config.rpcUrl = body.rpcUrl;
  if (body.buyAmountBnb !== undefined) config.buyAmountBnb = body.buyAmountBnb;
  if (body.slippagePct !== undefined) config.slippagePct = parseFloat(body.slippagePct);
  if (body.pollIntervalMs !== undefined) config.pollIntervalMs = parseInt(body.pollIntervalMs, 10);
  if (body.dryRun !== undefined) config.dryRun = body.dryRun === true || body.dryRun === "true";
  if (body.watchedCreators !== undefined) {
    config.watchedCreators = Array.isArray(body.watchedCreators)
      ? body.watchedCreators.map(s => s.trim().toLowerCase()).filter(Boolean)
      : body.watchedCreators.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    rebuildWatchedSet();
  }
  log("info", `Config updated — watched creators: ${config.watchedCreators.length}, dryRun: ${config.dryRun}`);
}

function getHistory() { return buyHistory; }

module.exports = {
  init, startSniper, stopSniper,
  getStatus, refreshBalance, getLogBuffer, getConfig, updateConfig, getHistory,
};

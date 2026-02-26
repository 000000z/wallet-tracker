const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");
const { WebSocketServer } = require("ws");

// ─── Express + HTTP + WebSocket Setup ────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());
app.use(express.static(__dirname));

// ─── Constants (Base chain — Clanker) ────────────────────────────────────────
const ADDRESSES = {
  feeLocker:       "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68",
  clankerFactory:  "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
  universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
  poolManager:     "0x498581ff718922c3f8e6a244956af099b2652b2b",
  v4Quoter:        "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
};

const KNOWN_HOOKS = [
  { addr: "0xd60D6B218116cFd801E28F78d011a203D2b068Cc", fee: "0x800000", label: "Dynamic v4.1" },
  { addr: "0x34a45c6B61876d739400Bd71228CbcbD4F53E8cC", fee: "0x800000", label: "Dynamic v4.0" },
  { addr: "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC", fee: "10000",   label: "Static v4.1" },
  { addr: "0xDd5EeaFff7BD481AD55Db083062b13a3cdf0A68CC", fee: "10000",   label: "Static v4.0" },
];

const WETH_BASE = "0x4200000000000000000000000000000000000006";
const TICK_SPACING = 200;
const GAS_LIMIT = 500000n;
const V4_SWAP_CMD = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

// ABIs
const FEE_LOCKER_ABI = [
  "event ClaimTokens(address indexed feeOwner, address indexed token, uint256 amountClaimed)",
];
const CLANKER_FACTORY_ABI = [
  "event TokenCreated(address indexed tokenAddress, address indexed creator, address hooks, uint24 fee, int24 tickSpacing)",
];
const UNIVERSAL_ROUTER_ABI = [
  "function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable",
];
const V4_QUOTER_ABI = [
  `function quoteExactInputSingle((
    address currency0, address currency1, uint24 fee, int24 tickSpacing,
    address hooks, uint128 amountIn, uint160 sqrtPriceLimitX96, bytes hookData
  )) external returns (uint256 amountOut, uint256 gasEstimate)`,
];

const claimTokenTopic = ethers.id("ClaimTokens(address,address,uint256)");

// ─── Sniper State ────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, "state.json");

let sniperRunning = false;
let pollTimer = null;
let lastBlock = 0;
let claimsDetected = 0;
let buysExecuted = 0;
let buyHistory = [];
const boughtTokens = new Map();
const poolKeyCache = new Map();

let provider = null;
let wallet = null;
let feeLocker = null;
let factory = null;
let quoter = null;

// ─── Config (from env vars, updatable at runtime) ────────────────────────────
let config = {
  privateKey:        process.env.PRIVATE_KEY || "",
  rpcUrl:            process.env.RPC_URL || "https://mainnet.base.org",
  buyAmountEth:      process.env.BUY_AMOUNT_ETH || "0.005",
  slippagePct:       parseFloat(process.env.SLIPPAGE_PCT || "10"),
  minClaimAmountWei: process.env.MIN_CLAIM_WEI || "1000000000000000",
  pollIntervalMs:    parseInt(process.env.POLL_INTERVAL_MS || "3000", 10),
  maxBuysPerToken:   parseInt(process.env.MAX_BUYS_PER_TOKEN || "1", 10),
  dryRun:            (process.env.DRY_RUN || "true") === "true",
  watchedTokens:     (process.env.WATCHED_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean),
  blacklistedTokens: (process.env.BLACKLISTED_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean),
};

// ─── Persistent State ────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      if (data.lastBlock) lastBlock = data.lastBlock;
      if (data.boughtTokens) {
        for (const [k, v] of Object.entries(data.boughtTokens)) {
          boughtTokens.set(k, v);
        }
      }
      if (data.buyHistory) buyHistory = data.buyHistory;
      if (data.claimsDetected) claimsDetected = data.claimsDetected;
      if (data.buysExecuted) buysExecuted = data.buysExecuted;
    }
  } catch (err) {
    console.error("Failed to load state:", err.message);
  }
}

function saveState() {
  try {
    const data = {
      lastBlock,
      boughtTokens: Object.fromEntries(boughtTokens),
      buyHistory,
      claimsDetected,
      buysExecuted,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save state:", err.message);
  }
}

// ─── Logging (console + WebSocket broadcast) ─────────────────────────────────
function log(type, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);

  // Broadcast to all connected WebSocket clients
  const payload = JSON.stringify({ type, msg, ts });
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

// ─── Pool Resolution ─────────────────────────────────────────────────────────
async function resolvePoolKey(tokenAddress, amountIn) {
  const tokenLower = tokenAddress.toLowerCase();
  if (poolKeyCache.has(tokenLower)) return poolKeyCache.get(tokenLower);

  // Sort token pair (V4 requires currency0 < currency1)
  const wethLower = WETH_BASE.toLowerCase();
  const [currency0, currency1] = tokenLower < wethLower
    ? [tokenAddress, WETH_BASE]
    : [WETH_BASE, tokenAddress];

  // Strategy 1: Known hook probing via quoter (no log queries needed)
  log("info", "  Trying known hooks via quoter...");
  for (const hook of KNOWN_HOOKS) {
    try {
      const params = {
        currency0,
        currency1,
        fee: hook.fee,
        tickSpacing: TICK_SPACING,
        hooks: hook.addr,
        amountIn,
        sqrtPriceLimitX96: 0n,
        hookData: "0x",
      };
      const result = await quoter.quoteExactInputSingle.staticCall(params);
      if (result.amountOut > 0n) {
        const poolKey = { hooks: hook.addr, fee: hook.fee, tickSpacing: TICK_SPACING, currency0, currency1 };
        log("info", `  Pool resolved via quoter: ${hook.label}`);
        poolKeyCache.set(tokenLower, poolKey);
        return poolKey;
      }
    } catch {
      // try next hook
    }
  }

  // Strategy 2: Factory event lookup (narrow range — Alchemy free = 10 blocks max)
  try {
    const currentBlock = await provider.getBlockNumber();
    const filter = factory.filters.TokenCreated(tokenAddress);
    // Search last 10 blocks only — token was likely just created if we're sniping it
    const events = await factory.queryFilter(filter, currentBlock - 9, currentBlock);
    if (events.length > 0) {
      const ev = events[0];
      const poolKey = {
        hooks: ev.args.hooks,
        fee: ev.args.fee.toString(),
        tickSpacing: Number(ev.args.tickSpacing),
        currency0,
        currency1,
      };
      log("info", `  Pool resolved via factory event: hook=${poolKey.hooks}, fee=${poolKey.fee}`);
      poolKeyCache.set(tokenLower, poolKey);
      return poolKey;
    }
  } catch (err) {
    log("error", `  Factory event lookup failed: ${err.message}`);
  }

  return null;
}

// ─── Swap Encoding ───────────────────────────────────────────────────────────
function encodeV4Swap(tokenAddress, poolKey, amountIn, amountOutMin) {
  const actions = ethers.solidityPacked(
    ["uint8", "uint8", "uint8"],
    [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
  );

  // Use sorted order from poolKey, determine swap direction
  const { currency0, currency1 } = poolKey;
  const zeroForOne = currency0.toLowerCase() !== tokenAddress.toLowerCase();

  const settleToken = zeroForOne ? currency0 : currency1;
  const takeToken = zeroForOne ? currency1 : currency0;

  const swapParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(tuple(address,address,uint24,int24,address) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint160 sqrtPriceLimitX96, bytes hookData)"],
    [{
      poolKey: { 0: currency0, 1: currency1, 2: poolKey.fee, 3: poolKey.tickSpacing, 4: poolKey.hooks },
      zeroForOne,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0n,
      hookData: "0x",
    }]
  );

  const settleParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"], [settleToken, amountIn]
  );
  const takeParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"], [takeToken, amountOutMin]
  );

  const v4Input = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes", "bytes[]"], [actions, [swapParams, settleParams, takeParams]]
  );

  const commands = ethers.solidityPacked(["uint8"], [V4_SWAP_CMD]);
  return { commands, inputs: [v4Input] };
}

// ─── Execute Buy ─────────────────────────────────────────────────────────────
async function executeBuy(tokenAddress, poolKey) {
  const amountIn = ethers.parseEther(config.buyAmountEth);

  // Get quote
  let amountOut;
  try {
    const result = await quoter.quoteExactInputSingle.staticCall({
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      fee: poolKey.fee,
      tickSpacing: poolKey.tickSpacing,
      hooks: poolKey.hooks,
      amountIn,
      sqrtPriceLimitX96: 0n,
      hookData: "0x",
    });
    amountOut = result[0];
    log("info", `  Quote: ${ethers.formatEther(amountIn)} ETH -> ${amountOut.toString()} tokens`);
  } catch (err) {
    log("error", `  Quote failed: ${err.message}`);
    return null;
  }

  // Apply slippage
  const slippageBps = BigInt(Math.round(config.slippagePct * 100));
  const amountOutMin = amountOut * (10000n - slippageBps) / 10000n;
  log("info", `  Min output (${config.slippagePct}% slippage): ${amountOutMin.toString()} tokens`);

  const buyCount = (boughtTokens.get(tokenAddress.toLowerCase()) || 0) + 1;

  if (config.dryRun) {
    log("buy", `DRY RUN: Would buy ${tokenAddress}... with ${config.buyAmountEth} ETH, ~${amountOut.toString()} tokens`);
    const entry = {
      token: tokenAddress, buyCount, amountIn: config.buyAmountEth,
      amountOut: amountOut.toString(), txHash: "", dryRun: true, time: Date.now(),
    };
    buyHistory.unshift(entry);
    saveState();
    return { dryRun: true, amountOut: amountOut.toString() };
  }

  // Encode and send swap
  const { commands, inputs } = encodeV4Swap(tokenAddress, poolKey, amountIn, amountOutMin);
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const router = new ethers.Contract(ADDRESSES.universalRouter, UNIVERSAL_ROUTER_ABI, wallet);

  try {
    const tx = await router.execute(commands, inputs, deadline, {
      value: amountIn, gasLimit: GAS_LIMIT,
    });
    log("buy", `TX sent: ${tx.hash}`);
    log("info", "  Waiting for confirmation...");

    const receipt = await tx.wait();
    log("buy", `TX confirmed in block ${receipt.blockNumber}, gas: ${receipt.gasUsed.toString()}`);
    log("buy", `BaseScan: https://basescan.org/tx/${tx.hash}`);

    const entry = {
      token: tokenAddress, buyCount, amountIn: config.buyAmountEth,
      amountOut: amountOut.toString(), txHash: tx.hash, dryRun: false, time: Date.now(),
    };
    buyHistory.unshift(entry);
    saveState();
    return { txHash: tx.hash, blockNumber: receipt.blockNumber, amountOut: amountOut.toString() };
  } catch (err) {
    log("error", `TX failed: ${err.message}`);
    return null;
  }
}

// ─── Resolve actual token from TX receipt (WETH fix) ─────────────────────────
const transferTopic = ethers.id("Transfer(address,address,uint256)");
const knownAddresses = new Set([
  WETH_BASE,
  ADDRESSES.feeLocker,
  ADDRESSES.clankerFactory,
  ADDRESSES.universalRouter,
  ADDRESSES.poolManager,
  ADDRESSES.v4Quoter,
  ...KNOWN_HOOKS.map(h => h.addr),
].map(a => a.toLowerCase()));

async function resolveTokenFromTx(txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return null;

    // 1. Look for a non-WETH ClaimTokens event in same TX
    const iface = new ethers.Interface(FEE_LOCKER_ABI);
    for (const logEntry of receipt.logs) {
      if (logEntry.address.toLowerCase() !== ADDRESSES.feeLocker.toLowerCase()) continue;
      if (logEntry.topics[0] !== claimTokenTopic) continue;
      try {
        const parsed = iface.parseLog({ topics: logEntry.topics, data: logEntry.data });
        const token = parsed.args.token;
        if (token.toLowerCase() !== WETH_BASE.toLowerCase()) return token;
      } catch { /* skip */ }
    }

    // 2. Look for ERC-20 Transfer from an unknown contract (the actual token)
    for (const logEntry of receipt.logs) {
      if (logEntry.topics[0] !== transferTopic) continue;
      if (!knownAddresses.has(logEntry.address.toLowerCase())) return logEntry.address;
    }

    // 3. Any log emitter that isn't known infrastructure
    for (const logEntry of receipt.logs) {
      if (!knownAddresses.has(logEntry.address.toLowerCase())) return logEntry.address;
    }
  } catch (err) {
    log("error", `  TX receipt lookup failed: ${err.message}`);
  }
  return null;
}

// ─── Process Claim Event ─────────────────────────────────────────────────────
async function processClaim(event) {
  const { feeOwner, token, amountClaimed } = event.args;

  claimsDetected++;

  // Determine actual token (WETH fix)
  let buyToken = token;
  const isWethClaim = token.toLowerCase() === WETH_BASE.toLowerCase();

  if (isWethClaim) {
    log("claim", `WETH FEE CLAIM from ${feeOwner}... (${ethers.formatEther(amountClaimed)} ETH)`);
    log("info", "  Checking TX for actual token...");
    const actualToken = await resolveTokenFromTx(event.transactionHash);
    if (!actualToken) {
      log("skip", `  SKIP: No token found in TX ${event.transactionHash}...`);
      return;
    }
    buyToken = actualToken;
    log("claim", `  Resolved token: ${buyToken}`);
  } else {
    log("claim", `CLAIM DETECTED: Token=${token} Owner=${feeOwner}`);
  }

  log("claim", `  Claim Amount: ${amountClaimed.toString()} wei (${ethers.formatEther(amountClaimed)} ETH)`);

  // Filter: min claim
  if (amountClaimed < BigInt(config.minClaimAmountWei)) {
    log("skip", `  SKIP: Claim below minimum (${config.minClaimAmountWei} wei)`);
    return;
  }

  // Filter: watched tokens
  if (config.watchedTokens.length > 0) {
    const isWatched = config.watchedTokens.some(w => w.toLowerCase() === buyToken.toLowerCase());
    if (!isWatched) {
      log("skip", `  SKIP: Token ${buyToken}... not in watched list`);
      return;
    }
  }

  // Filter: blacklist
  if (config.blacklistedTokens.length > 0) {
    const isBlacklisted = config.blacklistedTokens.some(b => b.toLowerCase() === buyToken.toLowerCase());
    if (isBlacklisted) {
      log("skip", `  SKIP: Token ${buyToken}... is blacklisted`);
      return;
    }
  }

  // Filter: max buys
  const buyCount = boughtTokens.get(buyToken.toLowerCase()) || 0;
  if (buyCount >= config.maxBuysPerToken) {
    log("skip", `  SKIP: Already bought ${buyToken}... ${buyCount}x (max: ${config.maxBuysPerToken})`);
    return;
  }

  // Resolve pool
  const amountIn = ethers.parseEther(config.buyAmountEth);
  const poolKey = await resolvePoolKey(buyToken, amountIn);
  if (!poolKey) {
    log("error", `  SKIP: Could not resolve pool for ${buyToken}`);
    return;
  }

  // Execute buy
  log("info", `  BUYING ${buyToken}... with ${config.buyAmountEth} ETH...`);
  const result = await executeBuy(buyToken, poolKey);

  if (result) {
    boughtTokens.set(buyToken.toLowerCase(), buyCount + 1);
    buysExecuted++;
    log("buy", `BUY COMPLETE for ${buyToken}...`);
    saveState();
  }
}

// ─── Poll Loop ───────────────────────────────────────────────────────────────
async function pollOnce() {
  if (!sniperRunning) return;

  try {
    const currentBlock = await provider.getBlockNumber();

    if (currentBlock > lastBlock) {
      const filter = feeLocker.filters.ClaimTokens();
      const events = await feeLocker.queryFilter(filter, lastBlock + 1, currentBlock);

      if (events.length > 0) {
        log("info", `Found ${events.length} claim(s) in blocks ${lastBlock + 1}-${currentBlock}`);
      }

      for (const event of events) {
        try {
          await processClaim(event);
        } catch (err) {
          log("error", `Error processing claim: ${err.message}`);
        }
      }

      lastBlock = currentBlock;
      saveState();
    }
  } catch (err) {
    log("error", `Poll error: ${err.message}`);
  }

  if (sniperRunning) {
    pollTimer = setTimeout(pollOnce, config.pollIntervalMs);
  }
}

// ─── Sniper Start / Stop ─────────────────────────────────────────────────────
async function startSniper() {
  if (sniperRunning) throw new Error("Sniper is already running");
  if (!config.privateKey || config.privateKey === "YOUR_BASE_WALLET_PRIVATE_KEY") {
    throw new Error("Private key not configured. Set PRIVATE_KEY env var.");
  }

  log("info", "═══ Clanker Claim Sniper Starting ═══");
  log("info", `RPC: ${config.rpcUrl}`);
  log("info", `Buy: ${config.buyAmountEth} ETH | Slippage: ${config.slippagePct}%`);
  log("info", `Dry Run: ${config.dryRun} | Poll: ${config.pollIntervalMs}ms`);

  provider = new ethers.JsonRpcProvider(config.rpcUrl);
  wallet = new ethers.Wallet(config.privateKey, provider);

  const balance = await provider.getBalance(wallet.address);
  log("info", `Wallet: ${wallet.address}`);
  log("info", `Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) log("error", "WARNING: Wallet has 0 ETH — swaps will fail");

  feeLocker = new ethers.Contract(ADDRESSES.feeLocker, FEE_LOCKER_ABI, provider);
  factory = new ethers.Contract(ADDRESSES.clankerFactory, CLANKER_FACTORY_ABI, provider);
  quoter = new ethers.Contract(ADDRESSES.v4Quoter, V4_QUOTER_ABI, provider);

  if (!lastBlock) {
    lastBlock = await provider.getBlockNumber();
  }
  log("info", `Starting from block ${lastBlock}`);
  log("info", "Listening for ClaimTokens events...");

  sniperRunning = true;
  pollTimer = setTimeout(pollOnce, config.pollIntervalMs);
}

function stopSniper() {
  sniperRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  log("info", "Sniper stopped");
  saveState();
}

// ─── REST API ────────────────────────────────────────────────────────────────
app.post("/api/sniper/start", async (req, res) => {
  try {
    await startSniper();
    res.json({ ok: true, status: "running" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/sniper/stop", (req, res) => {
  stopSniper();
  res.json({ ok: true, status: "stopped" });
});

app.get("/api/sniper/status", async (req, res) => {
  let walletAddr = "";
  let balance = "";
  let currentBlock = lastBlock;

  if (wallet) walletAddr = wallet.address;
  if (provider && wallet) {
    try {
      const bal = await provider.getBalance(wallet.address);
      balance = ethers.formatEther(bal);
      currentBlock = await provider.getBlockNumber();
    } catch { /* ignore */ }
  }

  res.json({
    running: sniperRunning,
    wallet: walletAddr,
    balance,
    block: currentBlock,
    claimsDetected,
    buysExecuted,
  });
});

app.get("/api/sniper/config", (req, res) => {
  // Mask private key
  const masked = { ...config };
  if (masked.privateKey) {
    masked.privateKey = masked.privateKey.slice(0, 6) + "..." + masked.privateKey.slice(-4);
  }
  res.json(masked);
});

app.post("/api/sniper/config", (req, res) => {
  const body = req.body;
  if (body.privateKey !== undefined) config.privateKey = body.privateKey;
  if (body.rpcUrl !== undefined) config.rpcUrl = body.rpcUrl;
  if (body.buyAmountEth !== undefined) config.buyAmountEth = body.buyAmountEth;
  if (body.slippagePct !== undefined) config.slippagePct = parseFloat(body.slippagePct);
  if (body.minClaimAmountWei !== undefined) config.minClaimAmountWei = body.minClaimAmountWei;
  if (body.pollIntervalMs !== undefined) config.pollIntervalMs = parseInt(body.pollIntervalMs, 10);
  if (body.maxBuysPerToken !== undefined) config.maxBuysPerToken = parseInt(body.maxBuysPerToken, 10);
  if (body.dryRun !== undefined) config.dryRun = body.dryRun === true || body.dryRun === "true";
  if (body.watchedTokens !== undefined) {
    config.watchedTokens = Array.isArray(body.watchedTokens)
      ? body.watchedTokens
      : body.watchedTokens.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }
  if (body.blacklistedTokens !== undefined) {
    config.blacklistedTokens = Array.isArray(body.blacklistedTokens)
      ? body.blacklistedTokens
      : body.blacklistedTokens.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }

  log("info", "Config updated via API");
  res.json({ ok: true, config: { ...config, privateKey: config.privateKey ? "***" : "" } });
});

app.get("/api/sniper/history", (req, res) => {
  res.json(buyHistory);
});

// ─── WebSocket (with heartbeat to prevent Railway proxy timeout) ─────────────
wss.on("connection", (ws) => {
  console.log("WebSocket client connected");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  // Send current state on connect
  ws.send(JSON.stringify({
    type: "info",
    msg: `Connected to sniper server. Status: ${sniperRunning ? "Running" : "Stopped"}`,
    ts: new Date().toISOString(),
  }));
});

// Ping every 25s to keep connections alive through Railway's proxy
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);
wss.on("close", () => clearInterval(heartbeat));

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
function shutdown() {
  console.log("\nShutting down...");
  stopSniper();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

loadState();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Site:   http://localhost:${PORT}`);
  console.log(`Sniper: http://localhost:${PORT}/sniper.html`);
  console.log(`WS:     ws://localhost:${PORT}/ws`);
});

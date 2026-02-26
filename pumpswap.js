// ─── PumpSwap Claim Sniper Module ────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const bs58 = require("bs58");

// ─── Constants ───────────────────────────────────────────────────────────────
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const COLLECT_FEE_EVENT_DISC = Buffer.from([232, 245, 194, 238, 234, 218, 58, 89]);
const COLLECT_FEE_IX_DISC = Buffer.from([160, 57, 89, 42, 181, 139, 43, 66]);
const POOL_BASE_MINT_OFFSET = 43;   // 8+1+2+32
const POOL_COIN_CREATOR_OFFSET = 211; // 8+1+2+32+32+32+32+32+32+8

// ─── State ───────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, "pumpswap-state.json");
const LOG_BUFFER_SIZE = 200;

let sniperRunning = false;
let connection = null;
let keypair = null;
let logSubId = null;
let claimsDetected = 0;
let buysExecuted = 0;
let buyHistory = [];
const boughtTokens = new Map();
const logBuffer = [];

// Broadcast function — set by init()
let broadcast = () => {};

// ─── Config ──────────────────────────────────────────────────────────────────
let config = {
  privateKey:       process.env.PUMP_PRIVATE_KEY || "",
  rpcUrl:           process.env.PUMP_RPC_URL || "",
  buyAmountSol:     parseFloat(process.env.PUMP_BUY_AMOUNT_SOL || "0.1"),
  slippagePct:      parseFloat(process.env.PUMP_SLIPPAGE_PCT || "25"),
  priorityFeeSol:   parseFloat(process.env.PUMP_PRIORITY_FEE_SOL || "0.005"),
  maxBuysPerToken:  parseInt(process.env.PUMP_MAX_BUYS_PER_TOKEN || "1", 10),
  dryRun:           (process.env.PUMP_DRY_RUN || "true") === "true",
  watchedTokens:    (process.env.PUMP_WATCHED_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean),
  blacklistedTokens: (process.env.PUMP_BLACKLISTED_TOKENS || "").split(",").map(s => s.trim()).filter(Boolean),
};

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(type, msg) {
  const ts = new Date().toISOString();
  console.log(`[PUMP ${ts}] ${msg}`);
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
      if (data.boughtTokens) for (const [k, v] of Object.entries(data.boughtTokens)) boughtTokens.set(k, v);
      if (data.buyHistory) buyHistory = data.buyHistory;
      if (data.claimsDetected) claimsDetected = data.claimsDetected;
      if (data.buysExecuted) buysExecuted = data.buysExecuted;
    }
  } catch (err) {
    console.error("Failed to load PumpSwap state:", err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      boughtTokens: Object.fromEntries(boughtTokens),
      buyHistory, claimsDetected, buysExecuted,
    }, null, 2));
  } catch (err) {
    console.error("Failed to save PumpSwap state:", err.message);
  }
}

// ─── Resolve exact token from claim TX ───────────────────────────────────────
async function resolveClaimToken(signature) {
  try {
    await new Promise(r => setTimeout(r, 500)); // wait for TX to be indexed
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) return null;

    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys || msg.accountKeys;
    const pumpAmmStr = PUMP_AMM.toBase58();

    for (const ix of (msg.compiledInstructions || [])) {
      const progKey = keys[ix.programIdIndex];
      if (!progKey || progKey.toBase58() !== pumpAmmStr) continue;

      const ixData = Buffer.from(ix.data);
      if (ixData.length < 8 || !ixData.slice(0, 8).equals(COLLECT_FEE_IX_DISC)) continue;

      // Account 0 = pool address in collect_coin_creator_fee instruction
      const poolAddress = keys[ix.accountKeyIndexes[0]];

      // Fetch pool account to get the specific base_mint
      const poolAccount = await connection.getAccountInfo(poolAddress);
      if (!poolAccount || poolAccount.data.length < POOL_BASE_MINT_OFFSET + 32) continue;

      const baseMint = new PublicKey(poolAccount.data.slice(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
      return { pool: poolAddress, baseMint };
    }
  } catch (err) {
    log("error", `Failed to resolve claim token: ${err.message}`);
  }
  return null;
}

// ─── Execute Buy (PumpPortal Local API) ──────────────────────────────────────
async function executeBuy(tokenMint) {
  const mintStr = tokenMint.toBase58();

  const buyCount = boughtTokens.get(mintStr) || 0;
  if (buyCount >= config.maxBuysPerToken) {
    log("skip", `SKIP: Already bought ${mintStr} ${buyCount}x (max: ${config.maxBuysPerToken})`);
    return null;
  }

  if (config.blacklistedTokens.some(b => b === mintStr)) {
    log("skip", `SKIP: Token ${mintStr} is blacklisted`);
    return null;
  }

  const balance = await connection.getBalance(keypair.publicKey);
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

  let priorityFee = config.priorityFeeSol;
  const maxFeeBudget = balanceSol * 0.05;
  if (priorityFee > maxFeeBudget) {
    priorityFee = parseFloat(maxFeeBudget.toFixed(6));
    log("info", `Priority fee capped at 5% of balance (${priorityFee} SOL)`);
  }

  if (config.dryRun) {
    log("buy", `DRY RUN: Would buy ${mintStr} with ${buyAmount} SOL`);
    boughtTokens.set(mintStr, buyCount + 1);
    buysExecuted++;
    buyHistory.unshift({ token: mintStr, buyCount: buyCount + 1, amountSol: buyAmount, txHash: "", dryRun: true, time: Date.now() });
    saveState();
    return { dryRun: true };
  }

  log("info", `BUYING ${mintStr} with ${buyAmount} SOL (priority: ${priorityFee} SOL)...`);

  try {
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: keypair.publicKey.toBase58(),
        action: "buy",
        mint: mintStr,
        denominatedInSol: "true",
        amount: buyAmount,
        slippage: config.slippagePct,
        priorityFee: priorityFee,
        pool: "pump-amm",
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

    boughtTokens.set(mintStr, buyCount + 1);
    buysExecuted++;
    buyHistory.unshift({ token: mintStr, buyCount: buyCount + 1, amountSol: buyAmount, txHash: sig, dryRun: false, time: Date.now() });
    saveState();
    return { txHash: sig };
  } catch (err) {
    log("error", `Buy failed: ${err.message}`);
    return null;
  }
}

// ─── Process Claim ───────────────────────────────────────────────────────────
async function processClaim(coinCreator, feeAmount, signature) {
  claimsDetected++;
  const creatorStr = coinCreator.toBase58();
  const feeSol = Number(feeAmount) / LAMPORTS_PER_SOL;

  log("claim", `FEE CLAIM by ${creatorStr} (${feeSol.toFixed(6)} SOL)`);
  log("info", `TX: ${signature} | Solscan: https://solscan.io/tx/${signature}`);

  log("info", `Resolving exact token from claim TX...`);
  const result = await resolveClaimToken(signature);

  if (!result) {
    log("skip", `SKIP: Could not resolve token from TX ${signature}`);
    return;
  }

  const mintStr = result.baseMint.toBase58();
  log("info", `Claimed token: ${mintStr} | Pool: ${result.pool.toBase58()}`);

  // Filter: only buy tokens in the watched list (if set)
  if (config.watchedTokens.length > 0) {
    if (!config.watchedTokens.some(w => w === mintStr)) {
      log("skip", `SKIP: Token ${mintStr} not in watched list`);
      return;
    }
  }

  await executeBuy(result.baseMint);
}

// ─── Start / Stop ────────────────────────────────────────────────────────────
async function startSniper() {
  if (sniperRunning) throw new Error("PumpSwap sniper is already running");
  if (!config.privateKey || config.privateKey === "YOUR_SOLANA_PRIVATE_KEY_BASE58") {
    throw new Error("Private key not configured. Set PUMP_PRIVATE_KEY env var.");
  }
  if (!config.rpcUrl) {
    throw new Error("RPC URL not configured. Set PUMP_RPC_URL env var.");
  }

  log("info", "=== PumpSwap Claim Sniper Starting ===");
  log("info", `RPC: ${config.rpcUrl.replace(/api-key=[^&]+/, "api-key=***")}`);
  log("info", `Buy: ${config.buyAmountSol} SOL | Slippage: ${config.slippagePct}%`);
  log("info", `Priority Fee: ${config.priorityFeeSol} SOL | Dry Run: ${config.dryRun}`);

  try {
    keypair = Keypair.fromSecretKey(bs58.decode(config.privateKey));
  } catch {
    throw new Error("Invalid private key (must be base58 Solana secret key)");
  }

  const wsUrl = config.rpcUrl.replace(/^https?/, "wss");
  connection = new Connection(config.rpcUrl, { wsEndpoint: wsUrl, commitment: "confirmed" });

  const balance = await connection.getBalance(keypair.publicKey);
  log("info", `Wallet: ${keypair.publicKey.toBase58()}`);
  log("info", `Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (balance === 0) log("error", "WARNING: Wallet has 0 SOL — buys will fail");

  log("info", "Subscribing to PumpSwap program logs...");

  logSubId = connection.onLogs(PUMP_AMM, async (logInfo) => {
    if (!sniperRunning) return;
    if (logInfo.err) return;

    const { signature, logs } = logInfo;
    const isClaimTx = logs.some(l => l.includes("CollectCoinCreatorFee") || l.includes("collect_coin_creator_fee"));
    if (!isClaimTx) return;

    let coinCreator = null;
    let feeAmount = 0n;

    // Parse event from "Program data:" log
    for (const logLine of logs) {
      if (!logLine.startsWith("Program data: ")) continue;
      try {
        const data = Buffer.from(logLine.slice(14), "base64");
        if (data.length < 56) continue;
        if (!data.slice(0, 8).equals(COLLECT_FEE_EVENT_DISC)) continue;
        coinCreator = new PublicKey(data.slice(16, 48));
        feeAmount = data.readBigUInt64LE(48);
        break;
      } catch { /* skip */ }
    }

    // Fallback: fetch full TX
    if (!coinCreator) {
      try {
        log("info", `Claim detected (TX: ${signature}), fetching accounts...`);
        await new Promise(r => setTimeout(r, 500));
        const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (tx) {
          const msg = tx.transaction.message;
          const keys = msg.staticAccountKeys || msg.accountKeys;
          const pumpAmmStr = PUMP_AMM.toBase58();
          for (const ix of (msg.compiledInstructions || [])) {
            const progKey = keys[ix.programIdIndex];
            if (progKey && progKey.toBase58() === pumpAmmStr) {
              const ixData = Buffer.from(ix.data);
              if (ixData.length >= 8 && ixData.slice(0, 8).equals(COLLECT_FEE_IX_DISC)) {
                coinCreator = keys[ix.accountKeyIndexes[2]];
                if (tx.meta && tx.meta.postBalances && tx.meta.preBalances) {
                  const idx = ix.accountKeyIndexes[2];
                  const diff = tx.meta.postBalances[idx] - tx.meta.preBalances[idx];
                  feeAmount = BigInt(Math.max(0, diff));
                }
                break;
              }
            }
          }
        }
      } catch (err) {
        log("error", `Failed to fetch TX: ${err.message}`);
      }
    }

    if (!coinCreator) {
      log("skip", `Could not parse claim from TX ${signature}`);
      return;
    }

    try {
      await processClaim(coinCreator, feeAmount, signature);
    } catch (err) {
      log("error", `Error processing claim: ${err.message}`);
    }
  }, "confirmed");

  sniperRunning = true;
  log("info", "Live event subscription active — listening for PumpSwap claims...");
}

function stopSniper() {
  sniperRunning = false;
  if (logSubId !== null && connection) {
    try { connection.removeOnLogsListener(logSubId); } catch {}
    logSubId = null;
  }
  log("info", "PumpSwap sniper stopped");
  saveState();
}

// ─── Exports ─────────────────────────────────────────────────────────────────
function init(broadcastFn) {
  broadcast = broadcastFn;
  loadState();
}

function getStatus() {
  return {
    running: sniperRunning,
    wallet: keypair ? keypair.publicKey.toBase58() : "",
    balance: "",
    claimsDetected,
    buysExecuted,
  };
}

async function getStatusWithBalance() {
  const status = getStatus();
  if (keypair && connection) {
    try {
      const bal = await connection.getBalance(keypair.publicKey);
      status.balance = (bal / LAMPORTS_PER_SOL).toFixed(4);
    } catch {}
  }
  return status;
}

function getConfig() {
  const masked = { ...config };
  if (masked.privateKey) masked.privateKey = masked.privateKey.slice(0, 6) + "..." + masked.privateKey.slice(-4);
  if (masked.rpcUrl && masked.rpcUrl.includes("api-key=")) masked.rpcUrl = masked.rpcUrl.replace(/api-key=[^&]+/, "api-key=***");
  return masked;
}

function updateConfig(body) {
  if (body.privateKey !== undefined) config.privateKey = body.privateKey;
  if (body.rpcUrl !== undefined) config.rpcUrl = body.rpcUrl;
  if (body.buyAmountSol !== undefined) config.buyAmountSol = parseFloat(body.buyAmountSol);
  if (body.slippagePct !== undefined) config.slippagePct = parseFloat(body.slippagePct);
  if (body.priorityFeeSol !== undefined) config.priorityFeeSol = parseFloat(body.priorityFeeSol);
  if (body.maxBuysPerToken !== undefined) config.maxBuysPerToken = parseInt(body.maxBuysPerToken, 10);
  if (body.dryRun !== undefined) config.dryRun = body.dryRun === true || body.dryRun === "true";
  if (body.watchedTokens !== undefined) {
    config.watchedTokens = Array.isArray(body.watchedTokens)
      ? body.watchedTokens : body.watchedTokens.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }
  if (body.blacklistedTokens !== undefined) {
    config.blacklistedTokens = Array.isArray(body.blacklistedTokens)
      ? body.blacklistedTokens : body.blacklistedTokens.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  }
  log("info", "PumpSwap config updated");
}

function getHistory() { return buyHistory; }
function getLogBuffer() { return logBuffer; }

module.exports = {
  init, startSniper, stopSniper,
  getStatus, getStatusWithBalance, getConfig, updateConfig,
  getHistory, getLogBuffer,
};

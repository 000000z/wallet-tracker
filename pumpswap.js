// ─── PumpSwap Claim Sniper Module ────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const bs58 = require("bs58");
const { notify, fetchTokenInfo, buildSocialFields } = require("./notify");

// ─── Constants ───────────────────────────────────────────────────────────────
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const COLLECT_FEE_EVENT_DISC = Buffer.from([122, 2, 127, 1, 14, 191, 12, 175]);
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
const scannedTokens = new Set();
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
      if (data.scannedTokens) for (const t of data.scannedTokens) scannedTokens.add(t);
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
      scannedTokens: [...scannedTokens],
      buyHistory, claimsDetected, buysExecuted,
    }, null, 2));
  } catch (err) {
    console.error("Failed to save PumpSwap state:", err.message);
  }
}

// ─── Creator Map (pre-built at startup) ──────────────────────────────────────
// Maps coin_creator address → [token mints] so claim lookups are instant
const creatorToTokens = new Map();

async function resolvePoolForToken(tokenMint) {
  // Use DexScreener to find the pool address for this token (free, no RPC credits)
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const data = await res.json();

    // Find the PumpSwap pair
    const pair = (data.pairs || []).find(p =>
      p.dexId === 'pumpswap' || p.labels?.includes('pump') ||
      p.url?.includes('pump') || p.dexId?.includes('pump')
    );

    if (pair && pair.pairAddress) {
      const poolPubkey = new PublicKey(pair.pairAddress);
      const poolAccount = await connection.getAccountInfo(poolPubkey);
      if (poolAccount && poolAccount.data.length >= POOL_COIN_CREATOR_OFFSET + 32) {
        // Verify discriminator
        if (poolAccount.data.slice(0, 8).equals(POOL_DISC)) {
          const coinCreator = new PublicKey(poolAccount.data.slice(POOL_COIN_CREATOR_OFFSET, POOL_COIN_CREATOR_OFFSET + 32));
          return coinCreator.toBase58();
        }
      }
    }
  } catch (err) {
    log("error", `DexScreener lookup failed for ${tokenMint}: ${err.message}`);
  }

  // Fallback: find pool via token's largest holder (pool holds most of supply)
  try {
    log("info", `Trying token largest accounts fallback for ${tokenMint}...`);
    const mintPubkey = new PublicKey(tokenMint);
    const result = await connection.getTokenLargestAccounts(mintPubkey);
    if (result.value && result.value.length > 0) {
      // Check top accounts — the pool's token account is owned by the pool PDA
      for (const account of result.value.slice(0, 5)) {
        const tokenAcct = await connection.getParsedAccountInfo(new PublicKey(account.address));
        if (!tokenAcct.value || !tokenAcct.value.data?.parsed) continue;
        const owner = tokenAcct.value.data.parsed.info.owner;
        // Check if owner is a PumpSwap pool
        const poolAccount = await connection.getAccountInfo(new PublicKey(owner));
        if (poolAccount && poolAccount.owner.equals(PUMP_AMM) &&
            poolAccount.data.length >= POOL_COIN_CREATOR_OFFSET + 32 &&
            poolAccount.data.slice(0, 8).equals(POOL_DISC)) {
          const coinCreator = new PublicKey(poolAccount.data.slice(POOL_COIN_CREATOR_OFFSET, POOL_COIN_CREATOR_OFFSET + 32));
          return coinCreator.toBase58();
        }
      }
    }
  } catch (err) {
    log("error", `Fallback pool lookup failed for ${tokenMint}: ${err.message}`);
  }

  return null;
}

async function buildCreatorMap() {
  creatorToTokens.clear();
  log("info", `Resolving creators for ${config.watchedTokens.length} watched token(s)...`);

  for (const tokenMint of config.watchedTokens) {
    const creator = await resolvePoolForToken(tokenMint);
    if (creator) {
      if (!creatorToTokens.has(creator)) creatorToTokens.set(creator, []);
      creatorToTokens.get(creator).push(tokenMint);
      log("info", `  ${tokenMint} → creator: ${creator}`);
    } else {
      log("error", `  ${tokenMint} → FAILED to resolve creator (token may not be on PumpSwap)`);
    }
  }

  log("info", `Creator map ready: ${creatorToTokens.size} creator(s) → ${config.watchedTokens.length} token(s)`);
  if (creatorToTokens.size === 0) {
    throw new Error("Could not resolve any watched tokens to creators. Check token mints.");
  }
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

  // Reserve: priority fee + base TX fee + token account rent + safety margin
  const overhead = config.priorityFeeSol + 0.003 + 0.005;
  if (buyAmount + overhead > balanceSol) {
    const adjusted = balanceSol - overhead;
    if (adjusted <= 0.001) {
      log("error", `SKIP: Balance too low (${balanceSol.toFixed(4)} SOL, need ${overhead.toFixed(4)} SOL overhead)`);
      return null;
    }
    log("info", `All-in: adjusted buy from ${buyAmount} to ${adjusted.toFixed(4)} SOL (balance: ${balanceSol.toFixed(4)})`);
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

  log("info", `BUYING ${mintStr} with ${buyAmount} SOL (slippage: ${config.slippagePct}%, priority: ${priorityFee} SOL, balance: ${balanceSol.toFixed(4)})...`);

  // Try buy, then retry once with higher slippage if it fails
  const attempts = [config.slippagePct, Math.min(config.slippagePct * 2, 50)];

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    const slippage = attempts[attempt];
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
          slippage: slippage,
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
        const errJson = JSON.stringify(confirmation.value.err);
        // Decode common PumpSwap errors
        const customMatch = errJson.match(/"Custom":(\d+)/);
        if (customMatch) {
          const code = parseInt(customMatch[1]);
          const errorNames = { 0: "InvalidInput", 1: "SlippageExceeded", 2: "InsufficientBalance", 6: "Overflow" };
          const name = errorNames[code] || `Unknown(${code})`;
          log("error", `TX failed: ${name} (Custom:${code}) — ${sig}`);

          // Retry with higher slippage if this was a slippage error
          if (code === 1 && attempt < attempts.length - 1) {
            log("info", `Retrying with higher slippage (${attempts[attempt + 1]}%)...`);
            continue;
          }
        } else {
          log("error", `TX failed: ${errJson}`);
        }
        return null;
      }

      log("buy", `TX confirmed: ${sig}`);
      log("buy", `Solscan: https://solscan.io/tx/${sig}`);

      boughtTokens.set(mintStr, buyCount + 1);
      buysExecuted++;
      buyHistory.unshift({ token: mintStr, buyCount: buyCount + 1, amountSol: buyAmount, txHash: sig, dryRun: false, time: Date.now() });
      saveState();

      const buyTokenInfo = await fetchTokenInfo(mintStr);
      const buyTokenLabel = buyTokenInfo?.name ? `**${buyTokenInfo.name}** (${buyTokenInfo.symbol})` : `\`${mintStr.slice(0,8)}...\``;

      notify("buy", "\u{2705} PumpSwap Buy Confirmed", `Successfully bought ${buyTokenLabel}`, {
        key: `pump-buy:${mintStr}`,
        chain: "SOL",
        url: `https://solscan.io/tx/${sig}`,
        thumbnail: buyTokenInfo?.image || undefined,
        fields: [
          ...(buyTokenInfo?.name ? [{ name: "\u{1fa99} Token", value: buyTokenLabel, inline: false }] : []),
          { name: "\u{1f4cd} Contract", value: `\`${mintStr}\``, inline: false },
          { name: "\u{1f4b0} Amount", value: `${buyAmount} SOL` },
          ...buildSocialFields(buyTokenInfo),
          { name: "\u{1f50d} TX", value: `[View on Solscan](https://solscan.io/tx/${sig})`, inline: false },
          { name: "\u{1f4cb} Quick Copy", value: `\`\`\`${mintStr}\`\`\``, inline: false },
        ],
      });

      return { txHash: sig };
    } catch (err) {
      log("error", `Buy failed: ${err.message}`);
      return null;
    }
  }
  return null;
}

// ─── Process Claim ───────────────────────────────────────────────────────────
async function processClaim(coinCreator, feeAmount, signature) {
  claimsDetected++;
  const creatorStr = coinCreator.toBase58();
  const feeSol = Number(feeAmount) / LAMPORTS_PER_SOL;

  // Instant lookup — no RPC calls needed
  const tokens = creatorToTokens.get(creatorStr);
  if (!tokens || tokens.length === 0) {
    // Not a creator we care about — skip silently (this is the common case)
    return;
  }

  // Filter already-scanned tokens
  const unscannedTokens = tokens.filter(t => !scannedTokens.has(t));
  if (unscannedTokens.length === 0) return; // all tokens already processed

  log("claim", `FEE CLAIM by ${creatorStr} (${feeSol.toFixed(6)} SOL)`);
  log("info", `TX: ${signature} | Solscan: https://solscan.io/tx/${signature}`);
  log("info", `Creator matches watched token(s): ${unscannedTokens.join(", ")}`);

  // Fetch socials for the first token
  const tokenInfo = await fetchTokenInfo(unscannedTokens[0]);
  const tokenLabel = tokenInfo?.name ? `**${tokenInfo.name}** (${tokenInfo.symbol})` : `\`${unscannedTokens[0].slice(0,8)}...\``;

  const claimFields = [
    ...(tokenInfo?.name ? [{ name: "\u{1fa99} Token", value: tokenLabel, inline: false }] : []),
    { name: "\u{1f4cd} Contract", value: `\`${unscannedTokens[0]}\``, inline: false },
    { name: "\u{1f464} Creator", value: `\`${creatorStr}\``, inline: false },
    { name: "\u{1f4b0} Fee", value: `${feeSol.toFixed(4)} SOL` },
    ...buildSocialFields(tokenInfo),
    { name: "\u{1f50d} TX", value: `[View on Solscan](https://solscan.io/tx/${signature})`, inline: false },
    { name: "\u{1f4cb} Quick Copy", value: `\`\`\`${unscannedTokens[0]}\`\`\``, inline: false },
  ];

  notify("claim", "\u{1f6a8} PumpSwap Fee Claim!", `Creator claimed fees on ${tokenLabel}`, {
    key: `pump-claim:${signature}`,
    chain: "SOL",
    url: `https://solscan.io/tx/${signature}`,
    thumbnail: tokenInfo?.image || undefined,
    fields: claimFields,
  });

  for (const tokenMint of unscannedTokens) {
    scannedTokens.add(tokenMint);
    await executeBuy(new PublicKey(tokenMint));
  }
  saveState();
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
  if (config.watchedTokens.length === 0) {
    throw new Error("Watched Tokens list is empty. Add at least one token mint to watch.");
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

  // Pre-build creator map: token mint → coin_creator (one-time at startup)
  await buildCreatorMap();

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
  if (body.buyAmountSol !== undefined) config.buyAmountSol = parseFloat(String(body.buyAmountSol).replace(",", "."));
  if (body.slippagePct !== undefined) config.slippagePct = parseFloat(String(body.slippagePct).replace(",", "."));
  if (body.priorityFeeSol !== undefined) config.priorityFeeSol = parseFloat(String(body.priorityFeeSol).replace(",", "."));
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
function getScannedTokens() { return [...scannedTokens]; }
function removeScanned(token) {
  const deleted = scannedTokens.delete(token);
  if (deleted) { saveState(); log("info", `Removed ${token} from scanned list`); }
  return deleted;
}

module.exports = {
  init, startSniper, stopSniper,
  getStatus, getStatusWithBalance, getConfig, updateConfig,
  getHistory, getLogBuffer, getScannedTokens, removeScanned,
};

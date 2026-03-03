// ─── Pump.fun GitHub Token Tracker Module ─────────────────────────────────────
// Monitors all new pump.fun token launches via PumpPortal WebSocket.
// If a token's metadata contains a GitHub link → Discord notification.

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { notify, buildSocialFields } = require("./notify");

// ─── Constants ───────────────────────────────────────────────────────────────
const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";
const STATE_FILE = path.join(__dirname, "pumpfun-tracker-state.json");
const LOG_BUFFER_SIZE = 200;

// ─── State ───────────────────────────────────────────────────────────────────
let trackerRunning = false;
let ws = null;
let reconnectTimer = null;
let tokensScanned = 0;
let githubTokensFound = 0;
const seenMints = new Set();
const logBuffer = [];

// Broadcast function — set by init()
let broadcast = () => {};

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(type, msg) {
  const ts = new Date().toISOString();
  console.log(`[PUMP.FUN ${ts}] ${msg}`);
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
      if (data.seenMints) for (const m of data.seenMints) seenMints.add(m);
      if (data.tokensScanned) tokensScanned = data.tokensScanned;
      if (data.githubTokensFound) githubTokensFound = data.githubTokensFound;
    }
  } catch (err) {
    console.error("Failed to load pump.fun tracker state:", err.message);
  }
}

function saveState() {
  try {
    // Only persist last 5000 mints to keep file manageable
    const recentMints = [...seenMints].slice(-5000);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      seenMints: recentMints,
      tokensScanned,
      githubTokensFound,
    }, null, 2));
  } catch (err) {
    console.error("Failed to save pump.fun tracker state:", err.message);
  }
}

// ─── GitHub Detection ────────────────────────────────────────────────────────
const GITHUB_REGEX = /github\.com\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?/gi;

function findGitHubLinks(metadata) {
  const links = new Set();
  const fields = [
    metadata.website,
    metadata.description,
    metadata.twitter,
    metadata.telegram,
  ];

  for (const field of fields) {
    if (!field || typeof field !== "string") continue;
    const matches = field.match(GITHUB_REGEX);
    if (matches) {
      for (const m of matches) links.add("https://" + m);
    }
  }

  return [...links];
}

// ─── Metadata Fetching ──────────────────────────────────────────────────────
async function fetchMetadata(uri) {
  if (!uri) return null;

  // Convert IPFS URIs to gateway URLs
  let url = uri;
  if (uri.startsWith("ipfs://")) {
    url = "https://ipfs.io/ipfs/" + uri.slice(7);
  } else if (uri.includes("/ipfs/")) {
    // Already a gateway URL, use as-is
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Process New Token ──────────────────────────────────────────────────────
async function processNewToken(tokenData) {
  const mint = tokenData.mint;
  if (!mint || seenMints.has(mint)) return;

  seenMints.add(mint);
  tokensScanned++;

  const name = tokenData.name || "Unknown";
  const symbol = tokenData.symbol || "???";
  const uri = tokenData.uri;

  // Fetch IPFS metadata for GitHub links
  let metadata = null;
  let githubLinks = [];

  if (uri) {
    metadata = await fetchMetadata(uri);
    if (metadata) {
      githubLinks = findGitHubLinks(metadata);
    }
  }

  // Also check the token event data itself for any website/socials
  if (tokenData.website) {
    const fromEvent = findGitHubLinks({ website: tokenData.website });
    for (const link of fromEvent) {
      if (!githubLinks.includes(link)) githubLinks.push(link);
    }
  }

  if (githubLinks.length === 0) return; // No GitHub — skip silently

  // GitHub found!
  githubTokensFound++;
  log("github", `GITHUB TOKEN: ${name} (${symbol}) — ${mint}`);
  log("info", `  GitHub: ${githubLinks.join(", ")}`);

  // Save state periodically
  if (tokensScanned % 50 === 0) saveState();

  // Build social links
  const socialParts = [];
  if (githubLinks.length > 0) socialParts.push(githubLinks.map(g => `\u{1f4bb} [GitHub](${g})`).join(" "));
  if (tokenData.twitter || metadata?.twitter) socialParts.push(`\u{1f426} [Twitter](${tokenData.twitter || metadata.twitter})`);
  if (tokenData.telegram || metadata?.telegram) socialParts.push(`\u{1f4ac} [Telegram](${tokenData.telegram || metadata.telegram})`);
  if (tokenData.website || metadata?.website) socialParts.push(`\u{1f310} [Website](${tokenData.website || metadata.website})`);

  const description = metadata?.description || tokenData.description || "";

  // Build Discord notification fields
  const fields = [
    { name: "\u{1fa99} Token", value: `**${name}** (${symbol})`, inline: false },
    { name: "\u{1f4cd} Contract", value: `\`${mint}\``, inline: false },
  ];

  if (socialParts.length > 0) {
    fields.push({ name: "\u{1f517} Socials", value: socialParts.join(" \u{2022} "), inline: false });
  }

  if (description) {
    fields.push({ name: "\u{1f4dd} Description", value: description.slice(0, 500), inline: false });
  }

  fields.push({
    name: "\u{1f50d} Links",
    value: `[Pump.fun](https://pump.fun/coin/${mint}) \u{2022} [Solscan](https://solscan.io/token/${mint})`,
    inline: false,
  });

  fields.push({
    name: "\u{1f4cb} Quick Copy",
    value: `\`\`\`${mint}\`\`\``,
    inline: false,
  });

  // Send Discord notification
  notify("info", "\u{1f4bb} New GitHub Token on Pump.fun", `**${name}** (${symbol}) launched with a GitHub link`, {
    key: `pumpfun-github:${mint}`,
    chain: "SOL",
    url: `https://pump.fun/coin/${mint}`,
    thumbnail: metadata?.image || tokenData.image_uri || undefined,
    fields,
  });
}

// ─── WebSocket Connection ───────────────────────────────────────────────────
function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  log("info", "Connecting to PumpPortal WebSocket...");

  ws = new WebSocket(PUMPPORTAL_WS);

  ws.on("open", () => {
    log("info", "Connected to PumpPortal WebSocket");

    // Subscribe to new token events
    ws.send(JSON.stringify({
      method: "subscribeNewToken",
    }));

    log("info", "Subscribed to new token events — monitoring for GitHub tokens...");
  });

  ws.on("message", async (data) => {
    if (!trackerRunning) return;

    try {
      const msg = JSON.parse(data.toString());

      // Process new token creation events
      if (msg.mint) {
        processNewToken(msg).catch(err => {
          log("error", `Error processing token ${msg.mint}: ${err.message}`);
        });
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    log("info", "PumpPortal WebSocket disconnected");
    if (trackerRunning) {
      log("info", "Reconnecting in 5s...");
      reconnectTimer = setTimeout(connectWebSocket, 5000);
    }
  });

  ws.on("error", (err) => {
    log("error", `WebSocket error: ${err.message}`);
  });
}

// ─── Start / Stop ────────────────────────────────────────────────────────────
function startTracker() {
  if (trackerRunning) throw new Error("Pump.fun tracker is already running");

  log("info", "=== Pump.fun GitHub Token Tracker Starting ===");
  log("info", "Monitoring all new pump.fun launches for GitHub links");
  log("info", `Previously seen: ${seenMints.size} mints | Found: ${githubTokensFound} GitHub tokens`);

  trackerRunning = true;
  connectWebSocket();
}

function stopTracker() {
  trackerRunning = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  log("info", "Pump.fun tracker stopped");
  saveState();
}

// ─── Exports ─────────────────────────────────────────────────────────────────
function init(broadcastFn) {
  broadcast = broadcastFn;
  loadState();
}

function getStatus() {
  return {
    running: trackerRunning,
    tokensScanned,
    githubTokensFound,
    seenMints: seenMints.size,
  };
}

function getLogBuffer() { return logBuffer; }

module.exports = {
  init, startTracker, stopTracker,
  getStatus, getLogBuffer,
};

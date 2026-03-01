// ─── Discord Notification Module ──────────────────────────────────────────────
// Sends formatted alerts to Discord via webhook. Anti-spam built in.

const WEBHOOK_URL = (process.env.DISCORD_WEBHOOK || "").trim();

console.log(`[notify] DISCORD_WEBHOOK ${WEBHOOK_URL ? "loaded (" + WEBHOOK_URL.length + " chars)" : "NOT SET — notifications disabled"}`);

// Anti-spam: cooldown per key (e.g., "buy:tokenMint" or "claim:creator")
const cooldowns = new Map();
const COOLDOWN_MS = 60_000; // 1 minute per unique event key

// Colors
const COLORS = {
  buy:    0x3fb950,  // green
  claim:  0xf0883e,  // orange
  error:  0xf85149,  // red
  info:   0x58a6ff,  // blue
  warn:   0xd29922,  // yellow
  grad:   0xa371f7,  // purple (graduation)
};

/**
 * Send a Discord notification
 * @param {string} type - buy|claim|error|info|warn|grad
 * @param {string} title - Short title
 * @param {string} description - Details (supports markdown)
 * @param {object} opts - { fields, key, chain, url, thumbnail }
 *   - fields: [{name, value, inline}] for embed fields
 *   - key: unique key for cooldown dedup (e.g., "buy:0x1234")
 *   - chain: "SOL" | "BASE" | "BNB" (shown as footer)
 *   - url: link for the embed title
 *   - thumbnail: image URL
 */
async function notify(type, title, description, opts = {}) {
  if (!WEBHOOK_URL) {
    console.log(`[notify] SKIP (no webhook): ${title}`);
    return;
  }

  // Anti-spam: skip if same key was sent recently
  if (opts.key) {
    const lastSent = cooldowns.get(opts.key);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
      console.log(`[notify] SKIP (cooldown): ${title} [key=${opts.key}]`);
      return;
    }
    cooldowns.set(opts.key, Date.now());
  }

  const embed = {
    title: title.slice(0, 256),
    description: (description || "").slice(0, 4096),
    color: COLORS[type] || COLORS.info,
    timestamp: new Date().toISOString(),
  };

  if (opts.fields && opts.fields.length > 0) {
    embed.fields = opts.fields.slice(0, 25).map(f => ({
      name: String(f.name).slice(0, 256),
      value: String(f.value).slice(0, 1024),
      inline: f.inline !== false,
    }));
  }

  if (opts.url) embed.url = opts.url;
  if (opts.thumbnail) embed.thumbnail = { url: opts.thumbnail };

  if (opts.chain) {
    const icons = { SOL: "◎", BASE: "🔵", BNB: "🟡" };
    embed.footer = { text: `${icons[opts.chain] || ""} ${opts.chain}` };
  }

  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (resp.ok) {
      console.log(`[notify] SENT: ${title}`);
    } else if (resp.status === 429) {
      // Rate limited by Discord — back off
      const data = await resp.json().catch(() => ({}));
      const retryMs = (data.retry_after || 1) * 1000;
      console.log(`[notify] Rate limited, retrying in ${retryMs}ms...`);
      await new Promise(r => setTimeout(r, retryMs));
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
      console.log(`[notify] SENT (retry): ${title}`);
    } else {
      const text = await resp.text().catch(() => "");
      console.error(`[notify] Discord returned ${resp.status}: ${text}`);
    }
  } catch (err) {
    console.error(`[notify] FAILED: ${err.message}`);
  }
}

// ─── Token Info (DexScreener) ─────────────────────────────────────────────────
const tokenInfoCache = new Map();
const TOKEN_CACHE_TTL = 300_000; // 5 min

/**
 * Fetch token name, symbol, socials, and image from DexScreener
 * @param {string} address - Token contract address
 * @returns {{ name, symbol, image, twitter, telegram, website } | null}
 */
async function fetchTokenInfo(address) {
  if (!address) return null;

  const cached = tokenInfoCache.get(address.toLowerCase());
  if (cached && Date.now() - cached.ts < TOKEN_CACHE_TTL) return cached.data;

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pair = (json.pairs || [])[0];
    if (!pair) return null;

    const info = {
      name: pair.baseToken?.name || null,
      symbol: pair.baseToken?.symbol || null,
      image: pair.info?.imageUrl || null,
      twitter: null,
      telegram: null,
      website: null,
    };

    for (const s of (pair.info?.socials || [])) {
      if (s.type === "twitter") info.twitter = s.url;
      if (s.type === "telegram") info.telegram = s.url;
    }
    for (const w of (pair.info?.websites || [])) {
      if (w.url && !info.website) info.website = w.url;
    }

    tokenInfoCache.set(address.toLowerCase(), { data: info, ts: Date.now() });
    return info;
  } catch (err) {
    console.log(`[notify] DexScreener lookup failed for ${address}: ${err.message}`);
    return null;
  }
}

/**
 * Build social link fields from token info
 * @param {object} info - Result from fetchTokenInfo
 * @returns {Array} Array of embed fields for socials
 */
function buildSocialFields(info) {
  if (!info) return [];
  const fields = [];

  if (info.twitter || info.telegram || info.website) {
    const links = [];
    if (info.twitter) links.push(`\u{1f426} [Twitter](${info.twitter})`);
    if (info.telegram) links.push(`\u{1f4ac} [Telegram](${info.telegram})`);
    if (info.website) links.push(`\u{1f310} [Website](${info.website})`);
    fields.push({ name: "\u{1f517} Socials", value: links.join(" \u{2022} "), inline: false });
  }

  return fields;
}

// Clean up old cooldown entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS * 2;
  for (const [key, ts] of cooldowns) {
    if (ts < cutoff) cooldowns.delete(key);
  }
}, 300_000);

module.exports = { notify, fetchTokenInfo, buildSocialFields };

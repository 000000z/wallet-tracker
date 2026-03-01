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

// Clean up old cooldown entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS * 2;
  for (const [key, ts] of cooldowns) {
    if (ts < cutoff) cooldowns.delete(key);
  }
}, 300_000);

module.exports = { notify };

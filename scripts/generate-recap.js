// Daily Recap Generator
// Runs via GitHub Actions — fetches trending Solana tokens from DexScreener,
// classifies them, and saves as a JSON recap file.

const https = require('https');
const fs = require('fs');
const path = require('path');

function fetch(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'ChillzRecapBot/1.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetch(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch(e) { reject(new Error('JSON parse error: ' + e.message)); }
                } else {
                    reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatMcap(v) {
    if (!v || v === 0) return '-';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(v);
}

function classifyCook(t) {
    if (t.priceChange24h < -60) return 'fast';
    if (t.priceChange24h < -30) return 'mid';
    if (t.priceChange24h > 0) return 'slow';
    return 'mid';
}

async function main() {
    const dateArg = process.argv[2];
    const today = dateArg || new Date().toISOString().split('T')[0];
    console.log('Generating recap for:', today);

    // Phase 1: Fetch boosted tokens
    console.log('Fetching boosted tokens from DexScreener...');
    let boostData;
    try {
        boostData = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    } catch(e) {
        console.error('Failed to fetch boosted tokens:', e.message);
        process.exit(1);
    }

    const seen = new Set();
    const solanaMints = [];
    for (const item of boostData) {
        if (item.chainId === 'solana' && item.tokenAddress && !seen.has(item.tokenAddress)) {
            seen.add(item.tokenAddress);
            solanaMints.push(item.tokenAddress);
        }
    }
    console.log('Found', solanaMints.length, 'unique Solana boosted tokens');

    // Phase 2: Get token details in batches
    console.log('Fetching token details...');
    const allTokens = [];
    const batchSize = 30;

    for (let i = 0; i < solanaMints.length; i += batchSize) {
        const batch = solanaMints.slice(i, i + batchSize);
        try {
            const pairs = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + batch.join(','));
            const byToken = {};
            for (const p of (Array.isArray(pairs) ? pairs : [])) {
                const addr = p.baseToken?.address;
                if (!addr) continue;
                const vol = p.volume?.h24 || 0;
                if (!byToken[addr] || vol > byToken[addr].volume24h) {
                    byToken[addr] = {
                        mint: addr,
                        symbol: p.baseToken?.symbol || '???',
                        name: p.baseToken?.name || '',
                        volume24h: vol,
                        priceUsd: parseFloat(p.priceUsd) || 0,
                        marketCap: p.marketCap || p.fdv || 0,
                        fdv: p.fdv || 0,
                        priceChange24h: p.priceChange?.h24 || 0,
                        priceChange6h: p.priceChange?.h6 || 0,
                        priceChange1h: p.priceChange?.h1 || 0,
                        liquidity: p.liquidity?.usd || 0,
                        pairAddress: p.pairAddress || '',
                        pairCreatedAt: p.pairCreatedAt || 0,
                        txns24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
                        buys24h: p.txns?.h24?.buys || 0,
                        sells24h: p.txns?.h24?.sells || 0,
                        url: p.url || ''
                    };
                }
            }
            for (const t of Object.values(byToken)) {
                if (!allTokens.find(x => x.mint === t.mint)) {
                    allTokens.push(t);
                }
            }
        } catch(e) {
            console.error('Batch error:', e.message);
        }
        await sleep(500); // Rate limit
    }

    // Sort by volume, take top 30
    allTokens.sort((a, b) => b.volume24h - a.volume24h);
    const topTokens = allTokens.slice(0, 30);

    console.log('Processed', allTokens.length, 'tokens, keeping top', topTokens.length);

    // Build recap
    const tokens = topTokens.map(t => ({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        description: '',
        athMcap: t.marketCap,
        currentMcap: t.marketCap,
        volume24h: t.volume24h,
        priceUsd: t.priceUsd,
        priceChange24h: t.priceChange24h,
        priceChange6h: t.priceChange6h,
        priceChange1h: t.priceChange1h,
        liquidity: t.liquidity,
        txns24h: t.txns24h,
        buys24h: t.buys24h,
        sells24h: t.sells24h,
        cook: classifyCook(t),
        tags: [],
        pairAddress: t.pairAddress,
        dexUrl: t.url
    }));

    const recap = {
        date: today,
        generatedAt: new Date().toISOString(),
        briefRecap: '',
        tokenCount: tokens.length,
        totalVolume: tokens.reduce((s, t) => s + t.volume24h, 0),
        tokens: tokens
    };

    // Save to file
    const outDir = path.join(__dirname, '..', 'data', 'recaps');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, today + '.json');
    fs.writeFileSync(outFile, JSON.stringify(recap, null, 2));
    console.log('Saved recap to', outFile);

    // Also update an index file listing all recaps
    const indexFile = path.join(outDir, 'index.json');
    let index = [];
    if (fs.existsSync(indexFile)) {
        try { index = JSON.parse(fs.readFileSync(indexFile, 'utf-8')); } catch(e) {}
    }
    if (!index.find(e => e.date === today)) {
        index.push({ date: today, tokenCount: tokens.length, totalVolume: recap.totalVolume });
    } else {
        const existing = index.find(e => e.date === today);
        existing.tokenCount = tokens.length;
        existing.totalVolume = recap.totalVolume;
    }
    index.sort((a, b) => b.date.localeCompare(a.date));
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    console.log('Updated index with', index.length, 'entries');

    // Summary
    console.log('\n--- Recap Summary ---');
    console.log('Date:', today);
    console.log('Tokens:', tokens.length);
    console.log('Top 5:');
    for (const t of tokens.slice(0, 5)) {
        console.log(' ', t.symbol, '|', formatMcap(t.marketCap), '| Vol', formatMcap(t.volume24h), '|', t.priceChange24h.toFixed(1) + '%', '|', t.cook);
    }
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});

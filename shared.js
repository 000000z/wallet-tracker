// Shared layout + trackers for all pages

// --- API Key Management ---
function getApiKey() {
    let key = localStorage.getItem('helius_api_key');
    if (!key) {
        key = prompt('Enter your Helius API key:');
        if (key) localStorage.setItem('helius_api_key', key);
    }
    return key;
}

// --- Helius Usage Tracker (real dashboard data + local increment) ---
function getHeliusData() {
    const def = { used: 0, total: 10000000, cycleStart: '', cycleEnd: '', localCalls: 0, updated: 0 };
    return Object.assign(def, JSON.parse(localStorage.getItem('helius_data') || '{}'));
}
function saveHeliusData(d) {
    d.updated = Date.now();
    localStorage.setItem('helius_data', JSON.stringify(d));
}
function trackHeliusCall() {
    const d = getHeliusData();
    d.localCalls = (d.localCalls || 0) + 1;
    saveHeliusData(d);
    updateTrackers();
}

// Patched fetch to auto-track Helius calls
const _origFetch = window.fetch;
window.fetch = function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (url.includes('helius') || url.includes('/api/rpc') || url.includes('/api/enhanced')) {
        trackHeliusCall();
    }
    return _origFetch.apply(this, args);
};

// --- Claude Usage Tracker (real data) ---
function getClaudeData() {
    const def = { used: 0, limit: 0, plan: '', resetDate: '', updated: 0 };
    return Object.assign(def, JSON.parse(localStorage.getItem('claude_data') || '{}'));
}
function saveClaudeData(d) {
    d.updated = Date.now();
    localStorage.setItem('claude_data', JSON.stringify(d));
}

// --- Sidebar + Top Bar ---
function injectLayout() {
    const currentPage = location.pathname.split('/').pop() || 'index.html';
    
    const pages = [
        { href: 'index.html', label: 'Explorer', icon: 'E' },
        { href: 'discover.html', label: 'Discover', icon: 'D' },
        { href: 'token-scanner.html', label: 'Token Scanner', icon: 'T' },
        { href: 'overlap.html', label: 'Overlap', icon: 'O' },
        { href: 'power-traders.html', label: 'Power Traders', icon: 'W' },
        { href: 'profile.html', label: 'Profile', icon: 'P' },
    ];
    
    const navItems = pages.map(p => {
        const active = currentPage === p.href;
        return '<a href="' + p.href + '" class="nav-item' + (active ? ' active' : '') + '">' +
            '<span class="nav-icon">' + p.icon + '</span>' +
            '<span class="nav-label">' + p.label + '</span>' +
        '</a>';
    }).join('');
    
    // Create sidebar
    const sidebar = document.createElement('div');
    sidebar.id = 'sidebar';
    sidebar.innerHTML = 
        '<div class="sidebar-title">Chillz</div>' +
        '<div class="sidebar-nav">' + navItems + '</div>' +
        '<div class="sidebar-bottom">' +
            '<button class="nav-item" onclick="changeApiKey()" style="width:100%;text-align:left;background:none;border:none;cursor:pointer;font-family:inherit;">' +
                '<span class="nav-icon">K</span><span class="nav-label">Change API Key</span>' +
            '</button>' +
        '</div>';
    
    // Create top bar with real tracker cards
    const topbar = document.createElement('div');
    topbar.id = 'topbar';
    topbar.innerHTML = 
        '<div class="tracker-card" id="heliusCard" onclick="promptHeliusData()" title="Click to sync from Helius dashboard">' +
            '<div class="tracker-header">' +
                '<span class="tracker-dot helius-dot"></span>' +
                '<span class="tracker-title">Helius</span>' +
            '</div>' +
            '<div class="tracker-bar-wrap"><div class="tracker-bar helius-bar" id="heliusBar"></div></div>' +
            '<div class="tracker-stats">' +
                '<span id="heliusUsed">--</span>' +
                '<span class="tracker-sep">/</span>' +
                '<span id="heliusTotal">--</span>' +
                '<span class="tracker-unit">credits</span>' +
            '</div>' +
            '<div class="tracker-meta" id="heliusMeta">click to sync</div>' +
        '</div>' +
        '<div class="tracker-card" id="claudeCard" onclick="promptClaudeData()" title="Click to sync from Claude dashboard">' +
            '<div class="tracker-header">' +
                '<span class="tracker-dot claude-dot"></span>' +
                '<span class="tracker-title">Claude</span>' +
            '</div>' +
            '<div class="tracker-bar-wrap"><div class="tracker-bar claude-bar" id="claudeBar"></div></div>' +
            '<div class="tracker-stats">' +
                '<span id="claudeUsed">--</span>' +
                '<span class="tracker-sep">/</span>' +
                '<span id="claudeTotal">--</span>' +
                '<span class="tracker-unit" id="claudeUnit">msgs</span>' +
            '</div>' +
            '<div class="tracker-meta" id="claudeMeta">click to sync</div>' +
        '</div>' +
        '<div class="tracker-spacer"></div>' +
        '<div class="tracker-local" id="localCallsDisplay" title="API calls made from this site since last sync">+<span id="localCalls">0</span> local</div>';
    
    // Wrap existing body content
    const content = document.createElement('div');
    content.id = 'main-content';
    while (document.body.firstChild) {
        content.appendChild(document.body.firstChild);
    }
    
    document.body.appendChild(sidebar);
    document.body.appendChild(topbar);
    document.body.appendChild(content);
    
    updateTrackers();
}

function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function timeAgo(ts) {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
}

function updateTrackers() {
    // Helius
    const h = getHeliusData();
    const hUsed = document.getElementById('heliusUsed');
    const hTotal = document.getElementById('heliusTotal');
    const hBar = document.getElementById('heliusBar');
    const hMeta = document.getElementById('heliusMeta');
    const localEl = document.getElementById('localCalls');
    
    if (hUsed && h.total > 0) {
        const effectiveUsed = h.used + (h.localCalls || 0);
        hUsed.textContent = formatNum(effectiveUsed);
        hTotal.textContent = formatNum(h.total);
        const pct = Math.min(100, (effectiveUsed / h.total) * 100);
        if (hBar) {
            hBar.style.width = pct + '%';
            hBar.className = 'tracker-bar helius-bar' + (pct > 80 ? ' danger' : pct > 50 ? ' warn' : '');
        }
        if (hMeta) {
            let meta = '';
            if (h.cycleEnd) {
                const daysLeft = Math.ceil((new Date(h.cycleEnd) - new Date()) / 86400000);
                meta = daysLeft + 'd left';
            }
            if (h.updated) meta += (meta ? ' | ' : '') + 'synced ' + timeAgo(h.updated);
            hMeta.textContent = meta || 'click to sync';
        }
    }
    if (localEl) localEl.textContent = h.localCalls || 0;
    
    // Claude
    const c = getClaudeData();
    const cUsed = document.getElementById('claudeUsed');
    const cTotal = document.getElementById('claudeTotal');
    const cBar = document.getElementById('claudeBar');
    const cMeta = document.getElementById('claudeMeta');
    const cUnit = document.getElementById('claudeUnit');
    
    if (cUsed && c.limit > 0) {
        cUsed.textContent = c.used;
        cTotal.textContent = c.limit;
        if (cUnit) cUnit.textContent = c.plan || 'msgs';
        const pct = Math.min(100, (c.used / c.limit) * 100);
        if (cBar) {
            cBar.style.width = pct + '%';
            cBar.className = 'tracker-bar claude-bar' + (pct > 80 ? ' danger' : pct > 50 ? ' warn' : '');
        }
        if (cMeta) {
            let meta = '';
            if (c.resetDate) meta = 'resets ' + c.resetDate;
            if (c.updated) meta += (meta ? ' | ' : '') + 'synced ' + timeAgo(c.updated);
            cMeta.textContent = meta || 'click to sync';
        }
    }
}

function promptHeliusData() {
    const current = getHeliusData();
    const input = prompt(
        'Sync from Helius dashboard:\n' +
        'Format: used / total / cycle-end\n' +
        'Example: 374394 / 10000000 / 2026-03-17',
        (current.used || 374394) + ' / ' + (current.total || 10000000) + ' / ' + (current.cycleEnd || '2026-03-17')
    );
    if (!input) return;
    const parts = input.split('/').map(s => s.trim());
    const d = getHeliusData();
    d.used = parseInt(parts[0]) || 0;
    d.total = parseInt(parts[1]) || 10000000;
    if (parts[2]) d.cycleEnd = parts[2];
    d.localCalls = 0; // reset local counter on sync
    saveHeliusData(d);
    updateTrackers();
}

function promptClaudeData() {
    const current = getClaudeData();
    const input = prompt(
        'Sync from Claude dashboard:\n' +
        'Format: used / limit\n' +
        'Example: 45 / 45 for Opus messages',
        (current.used || 0) + ' / ' + (current.limit || 45)
    );
    if (!input) return;
    const parts = input.split('/').map(s => s.trim());
    const d = getClaudeData();
    d.used = parseInt(parts[0]) || 0;
    d.limit = parseInt(parts[1]) || 45;
    saveClaudeData(d);
    updateTrackers();
}

function changeApiKey() {
    localStorage.removeItem('helius_api_key');
    location.reload();
}

// Inject on load
document.addEventListener('DOMContentLoaded', injectLayout);

// Update trackers every 30s
setInterval(updateTrackers, 30000);

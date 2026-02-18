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

// --- Helius Usage Tracker ---
function trackHeliusCall() {
    const today = new Date().toISOString().slice(0, 10);
    const data = JSON.parse(localStorage.getItem('helius_usage') || '{}');
    if (!data[today]) data[today] = 0;
    data[today]++;
    // Clean old days (keep 7 days)
    const keys = Object.keys(data).sort();
    while (keys.length > 7) { delete data[keys.shift()]; }
    localStorage.setItem('helius_usage', JSON.stringify(data));
    updateTrackers();
}

function getHeliusUsage() {
    const today = new Date().toISOString().slice(0, 10);
    const data = JSON.parse(localStorage.getItem('helius_usage') || '{}');
    return { today: data[today] || 0, total: Object.values(data).reduce((a, b) => a + b, 0) };
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

// --- Claude Usage (manual tracker) ---
function getClaudeUsage() {
    const data = JSON.parse(localStorage.getItem('claude_usage') || '{"used":0,"limit":0,"note":""}');
    return data;
}
function setClaudeUsage(used, limit) {
    localStorage.setItem('claude_usage', JSON.stringify({ used, limit, updated: Date.now() }));
    updateTrackers();
}

// --- Sidebar + Top Bar ---
function injectLayout() {
    const currentPage = location.pathname.split('/').pop() || 'index.html';
    
    const pages = [
        { href: 'index.html', label: 'Explorer', icon: 'E' },
        { href: 'discover.html', label: 'Discover', icon: 'D' },
        { href: 'token-scanner.html', label: 'Token Scanner', icon: 'T' },
        { href: 'overlap.html', label: 'Overlap', icon: 'O' },
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
    
    // Create top bar
    const topbar = document.createElement('div');
    topbar.id = 'topbar';
    topbar.innerHTML = 
        '<div class="tracker" id="heliusTracker">' +
            '<span class="tracker-label">Helius</span>' +
            '<span class="tracker-value" id="heliusCount">0</span>' +
            '<span class="tracker-sub">today</span>' +
        '</div>' +
        '<div class="tracker" id="claudeTracker" onclick="promptClaudeUsage()" style="cursor:pointer;" title="Click to update">' +
            '<span class="tracker-label">Claude</span>' +
            '<span class="tracker-value" id="claudeCount">--</span>' +
            '<span class="tracker-sub" id="claudeSub">click to set</span>' +
        '</div>' +
        '<div class="tracker-spacer"></div>' +
        '<button onclick="resetHeliusCount()" style="background:none;border:1px solid #2a2a3e;color:#666;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px;font-family:inherit;">Reset Helius</button>';
    
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

function updateTrackers() {
    const h = getHeliusUsage();
    const hEl = document.getElementById('heliusCount');
    if (hEl) hEl.textContent = h.today.toLocaleString();
    
    const c = getClaudeUsage();
    const cEl = document.getElementById('claudeCount');
    const cSub = document.getElementById('claudeSub');
    if (cEl && c.limit) {
        cEl.textContent = c.used + '/' + c.limit;
        const pct = Math.round((c.used / c.limit) * 100);
        cEl.style.color = pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#22c55e';
        if (cSub) {
            const ago = c.updated ? Math.round((Date.now() - c.updated) / 60000) : 0;
            cSub.textContent = ago < 60 ? ago + 'm ago' : Math.round(ago / 60) + 'h ago';
        }
    }
}

function promptClaudeUsage() {
    const current = getClaudeUsage();
    const input = prompt('Claude usage (used/limit, e.g. 150/500):', current.limit ? current.used + '/' + current.limit : '');
    if (!input) return;
    const parts = input.split('/');
    if (parts.length === 2) {
        setClaudeUsage(parseInt(parts[0]) || 0, parseInt(parts[1]) || 500);
    }
}

function changeApiKey() {
    localStorage.removeItem('helius_api_key');
    location.reload();
}

function resetHeliusCount() {
    const today = new Date().toISOString().slice(0, 10);
    const data = JSON.parse(localStorage.getItem('helius_usage') || '{}');
    data[today] = 0;
    localStorage.setItem('helius_usage', JSON.stringify(data));
    updateTrackers();
}

// Inject on load
document.addEventListener('DOMContentLoaded', injectLayout);

// Update trackers every 30s
setInterval(updateTrackers, 30000);

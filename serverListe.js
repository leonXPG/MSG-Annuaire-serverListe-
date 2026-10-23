#!/usr/bin/env node
/**
 * SERVER LISTE — Annuaire public centralisé pour serveurs MSG
 *
 * Zéro dépendance npm — Node.js standard (http, url, path, fs).
 * Rôle :
 *  - Reçoit les annonces périodiques (heartbeat) des serveurs MSG via POST /api/announce
 *  - Supprime automatiquement les serveurs inactifs (timeout 90s)
 *  - Fournit la liste des serveurs actifs aux clients via GET /api/servers
 *  - Propose une page d'accueil web moderne avec statistiques en direct (GET /)
 *
 * Lancement :
 *   node serverListe.js
 *   ou PORT=8788 node serverListe.js
 */

const http = require('http');
const url = require('url');

const PORT = parseInt(process.env.PORT, 10) || 8788;
const HEARTBEAT_TIMEOUT_MS = 90 * 1000; // 90 secondes max sans heartbeat avant retrait

// Map en mémoire : "host:port" -> objet serveur
const servers = new Map();

function cleanIp(ip) {
  if (!ip) return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.replace('::ffff:', '');
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first) return cleanIp(first);
  }
  return cleanIp(req.socket.remoteAddress);
}

// Nettoyage régulier des serveurs silencieux
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of servers.entries()) {
    if (now - s.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      servers.delete(key);
      console.log(`[Annuaire] Serveur expiré retiré : ${s.name} (${key})`);
    }
  }
}, 15000);

function getActiveServers() {
  const now = Date.now();
  const list = [];
  for (const s of servers.values()) {
    if (now - s.lastSeen <= HEARTBEAT_TIMEOUT_MS) {
      list.push({
        id: s.id,
        name: s.name,
        icon: s.icon,
        type: s.type,
        host: s.host,
        port: s.port,
        userCount: s.userCount || 0,
        channels: s.channels || [],
        description: s.description || '',
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        uptimeSeconds: Math.floor((now - s.firstSeen) / 1000)
      });
    }
  }
  // Tri par nombre d'utilisateurs connectés décroissant, puis par fraîcheur
  list.sort((a, b) => (b.userCount - a.userCount) || (b.lastSeen - a.lastSeen));
  return list;
}

function parseJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => {
      buf += chunk;
      if (buf.length > limitBytes) {
        req.destroy();
        reject(new Error('Payload trop volumineux'));
      }
    });
    req.on('end', () => {
      if (!buf.trim()) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data, null, 2));
}

function renderHtmlDashboard() {
  const activeList = getActiveServers();
  const totalUsers = activeList.reduce((acc, s) => acc + (s.userCount || 0), 0);
  const uptime = Math.floor(process.uptime());

  const serverCards = activeList.map(s => `
    <div class="server-card">
      <div class="card-head">
        <div class="card-icon">${s.icon || '💬'}</div>
        <div class="card-title-wrap">
          <div class="card-name">${escapeHtml(s.name)}</div>
          <div class="card-endpoint">${escapeHtml(s.host)}:${s.port}</div>
        </div>
        <span class="type-badge ${s.type}">${s.type === 'both' ? 'Salons & MP' : (s.type === 'mp' ? 'Relais MP' : 'Salons')}</span>
      </div>
      ${s.description ? `<div class="card-desc">${escapeHtml(s.description)}</div>` : ''}
      <div class="card-footer">
        <span class="user-pill"><span class="dot-online"></span>${s.userCount} en ligne</span>
        ${s.channels && s.channels.length ? `<span class="channels-preview">${s.channels.slice(0, 3).map(c => '#' + escapeHtml(c)).join(' ')}${s.channels.length > 3 ? ` +${s.channels.length - 3}` : ''}</span>` : ''}
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/icon.png">
  <title>Annuaire des serveurs MSG</title>
  <style>
    :root {
      --bg: #0b0f17;
      --bg-panel: #121824;
      --bg-card: #182030;
      --line: #222d42;
      --text: #e2e8f0;
      --text-dim: #8b9bb4;
      --signal: #4fe0c4;
      --signal-glow: rgba(79, 224, 196, 0.25);
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --mono: "SF Mono", Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 30px 16px;
    }
    .container { width: 100%; max-width: 860px; }
    header {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-panel);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 13px;
      color: var(--signal);
      font-weight: 600;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    p.sub {
      color: var(--text-dim);
      font-size: 14px;
      max-width: 520px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .stats-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--bg-panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
    }
    .stat-val {
      font-size: 24px;
      font-weight: 800;
      color: var(--signal);
      font-family: var(--mono);
    }
    .stat-label {
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 4px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-dim);
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .api-link {
      font-size: 12px;
      color: var(--signal);
      text-decoration: none;
      font-family: var(--mono);
    }
    .api-link:hover { text-decoration: underline; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 14px;
      margin-bottom: 32px;
    }
    .server-card {
      background: var(--bg-panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: transform 0.15s, border-color 0.15s;
    }
    .server-card:hover {
      transform: translateY(-2px);
      border-color: rgba(79, 224, 196, 0.4);
    }
    .card-head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-icon {
      font-size: 22px;
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: var(--bg-card);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .card-title-wrap { flex: 1; min-width: 0; }
    .card-name {
      font-weight: 700;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-endpoint {
      font-size: 11px;
      color: var(--text-dim);
      font-family: var(--mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .type-badge {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 3px 7px;
      border-radius: 6px;
      border: 1px solid;
    }
    .type-badge.channels { color: #60a5fa; border-color: rgba(96, 165, 250, 0.3); background: rgba(96, 165, 250, 0.1); }
    .type-badge.mp { color: #f472b6; border-color: rgba(244, 114, 182, 0.3); background: rgba(244, 114, 182, 0.1); }
    .type-badge.both { color: #4fe0c4; border-color: rgba(79, 224, 196, 0.3); background: rgba(79, 224, 196, 0.1); }
    .card-desc {
      font-size: 12.5px;
      color: var(--text-dim);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: auto;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      font-size: 11.5px;
    }
    .user-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--signal);
      font-weight: 600;
    }
    .dot-online {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--signal);
      box-shadow: 0 0 6px var(--signal);
    }
    .channels-preview {
      color: var(--text-dim);
      font-family: var(--mono);
      font-size: 11px;
    }
    .empty-box {
      text-align: center;
      padding: 40px 20px;
      background: var(--bg-panel);
      border: 1px dashed var(--line);
      border-radius: 12px;
      color: var(--text-dim);
      font-size: 14px;
      line-height: 1.6;
    }
    footer {
      text-align: center;
      font-size: 12px;
      color: var(--text-dim);
      margin-top: auto;
      padding-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-badge">🌐 MSG SERVER LIST</div>
      <h1>Annuaire Public des Serveurs</h1>
      <p class="sub">Répertoire centralisé des nœuds et relais du réseau MSG. Les serveurs actifs s'annoncent automatiquement.</p>
    </header>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-val">${activeList.length}</div>
        <div class="stat-label">Serveurs Actifs</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${totalUsers}</div>
        <div class="stat-label">Utilisateurs en Ligne</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${Math.floor(uptime / 60)}m ${uptime % 60}s</div>
        <div class="stat-label">Uptime Registre</div>
      </div>
    </div>

    <div class="section-title">
      <span>Serveurs Référencés</span>
      <a href="/api/servers" class="api-link" target="_blank">GET /api/servers →</a>
    </div>

    ${activeList.length ? `<div class="grid">${serverCards}</div>` : `
      <div class="empty-box">
        <p><strong>Aucun serveur n'est actuellement connecté à cet annuaire.</strong></p>
        <p style="margin-top: 6px; font-size: 12px;">Active l'option <code>"serverList": { "enabled": true }</code> dans la configuration de ton serveur <code>server.js</code> pour qu'il apparaisse ici !</p>
      </div>
    `}

    <footer>
      MSG Decentralized Mesh · Annuaire open source · Actualisé en temps réel
    </footer>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const httpServer = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  // Gestion CORS pré-vol (OPTIONS)
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  /* ===== GET / — Dashboard HTML ===== */
  if (method === 'GET' && pathname === '/') {
    const html = renderHtmlDashboard();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(html);
  }

  /* ===== GET /api/servers ou /servers — Liste JSON ===== */
  if (method === 'GET' && (pathname === '/api/servers' || pathname === '/servers')) {
    const active = getActiveServers();
    return sendJson(res, 200, {
      ok: true,
      total: active.length,
      servers: active
    });
  }

  /* ===== GET /api/health — Statut santé ===== */
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      serverCount: servers.size
    });
  }

  /* ===== POST /api/announce ou /announce — Enregistrement / Heartbeat ===== */
  if (method === 'POST' && (pathname === '/api/announce' || pathname === '/announce')) {
    try {
      const body = await parseJsonBody(req);
      const name = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim().slice(0, 40) : 'Serveur MSG';
      const port = parseInt(body.port, 10);
      if (!port || port < 1 || port > 65535) {
        return sendJson(res, 400, { ok: false, error: 'Port invalide' });
      }

      // Si l'hôte n'est pas fourni ou est local, on utilise l'IP source détectée
      const detectedIp = getClientIp(req);
      let host = (typeof body.host === 'string' && body.host.trim()) ? body.host.trim().slice(0, 100) : detectedIp;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        // Si le serveur s'annonce depuis l'extérieur, on garde l'IP publique détectée
        if (detectedIp && detectedIp !== '127.0.0.1' && detectedIp !== '::1') {
          host = detectedIp;
        }
      }

      const key = `${host}:${port}`;
      const now = Date.now();
      const existing = servers.get(key);

      const record = {
        id: key,
        name,
        icon: (typeof body.icon === 'string') ? body.icon.slice(0, 8) : (existing?.icon || '💬'),
        type: (body.type === 'mp' || body.type === 'channels' || body.type === 'both') ? body.type : (existing?.type || 'both'),
        host,
        port,
        userCount: typeof body.userCount === 'number' ? Math.max(0, Math.floor(body.userCount)) : 0,
        channels: Array.isArray(body.channels) ? body.channels.filter(c => typeof c === 'string').slice(0, 20) : (existing?.channels || []),
        description: (typeof body.description === 'string') ? body.description.trim().slice(0, 200) : (existing?.description || ''),
        firstSeen: existing ? existing.firstSeen : now,
        lastSeen: now
      };

      servers.set(key, record);
      console.log(`[Annuaire] Annonce reçue de "${name}" (${key}) — ${record.userCount} utilisateur(s)`);

      return sendJson(res, 200, {
        ok: true,
        message: 'Serveur enregistré avec succès',
        id: key,
        heartbeatIntervalMs: 30000
      });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  /* ===== POST /api/leave ou /leave — Retrait propre ===== */
  if (method === 'POST' && (pathname === '/api/leave' || pathname === '/leave')) {
    try {
      const body = await parseJsonBody(req);
      const port = parseInt(body.port, 10);
      const detectedIp = getClientIp(req);
      const host = body.host || detectedIp;
      const key = `${host}:${port}`;
      if (servers.has(key)) {
        servers.delete(key);
        console.log(`[Annuaire] Serveur déconnecté (leave) : ${key}`);
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (method === 'GET' && pathname === '/icon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(require('fs').readFileSync(require('path').join(__dirname, 'icon.png')));
  }
  
  // Route introuvable
  return sendJson(res, 404, { ok: false, error: 'Route non trouvée' });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`🌐 MSG SERVER LISTE démarré sur http://0.0.0.0:${PORT}`);
  console.log(`   - Dashboard web : http://localhost:${PORT}/`);
  console.log(`   - API serveurs  : http://localhost:${PORT}/api/servers`);
  console.log(`   - Annonce       : POST http://localhost:${PORT}/api/announce`);
  console.log(`==================================================\n`);
});

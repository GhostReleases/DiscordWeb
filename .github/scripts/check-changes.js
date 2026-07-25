const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// ==============================
// CONFIG – ROLE IDs 
// ==============================
const ROLE_RELEASES = '<@&1530516129158529175>';   
const ROLE_UPDATES = '<@&1530516105846587483>';    
const ROLE_STATUS = '<@&1530529602265550988>';     

// ==============================
// 1. Load previous state
// ==============================
const stateFile = path.join(__dirname, '../../state.json');
let previous = { games: [], updates: [], status: [] };
if (fs.existsSync(stateFile)) {
  previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// ==============================
// 2. Fetch current data from live site
// ==============================
async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  return res.text();
}

async function run() {
  try {
    const scriptJs = await fetchFile('https://ghostreleases.com/script.js');
    const statusHtml = await fetchFile('https://ghostreleases.com/status.html');

    // --- Parse gamesData from script.js ---
    const gameMatch = scriptJs.match(/const gamesData = (\[[\s\S]*?\]);/);
    if (!gameMatch) throw new Error('Could not find gamesData');
    const gamesData = eval(gameMatch[1]);
    console.log(`📊 Total games parsed: ${gamesData.length}`);
    console.log(`📊 Last 3 games:`, gamesData.slice(-3).map(g => g.title));
    console.log(`📊 New games found:`, newGames.map(g => g.title));

    // --- Parse repackProjects from status.html ---
    const statusMatch = statusHtml.match(/const repackProjects = (\[[\s\S]*?\]);/);
    if (!statusMatch) throw new Error('Could not find repackProjects');
    const repackProjects = eval(statusMatch[1]);

    // ==============================
    // 3. Detect changes
    // ==============================

    // 3a. New games (by id)
    const currentGames = gamesData.map(g => ({ id: g.id, title: g.title }));
    const newGames = currentGames.filter(g => !previous.games.some(p => p.id === g.id));

    // 3b. New updates (by version + gameId)
    const currentUpdates = gamesData.flatMap(g =>
      (g.updates || []).map(u => ({
        gameId: g.id,
        gameTitle: g.title,
        version: u.version,
        date: u.date,
        description: u.description || ''
      }))
    );
    const newUpdates = currentUpdates.filter(u =>
      !previous.updates.some(p => p.version === u.version && p.gameId === u.gameId)
    );

    // 3c. New status projects (by name)
    const currentStatus = repackProjects.map(p => ({
      name: p.name,
      status: p.status,
      eta: p.eta,
      details: p.details || ''
    }));
    const newStatus = currentStatus.filter(p =>
      !previous.status.some(s => s.name === p.name)
    );

    // Also detect status changes (ETA/status updated)
    const changedStatus = currentStatus.filter(p => {
      const prev = previous.status.find(s => s.name === p.name);
      if (!prev) return false;
      return prev.status !== p.status || prev.eta !== p.eta;
    });

    // ==============================
    // 4. Build messages WITH ROLE PINGS
    // ==============================

    // --- RELEASES (only new games) ---
    let releaseMsg = '';
    if (newGames.length > 0) {
      releaseMsg += `${ROLE_RELEASES}\n`;
      releaseMsg += '**🎮 New Release(s):**\n';
      newGames.forEach(g => releaseMsg += `• **${g.title}** (ID: ${g.id})\n`);
      releaseMsg += '\n📥 Download now on our website!';
    }

    // --- UPDATES (only game updates) ---
    let updatesMsg = '';
    if (newUpdates.length > 0) {
      updatesMsg += `${ROLE_UPDATES}\n`;
      updatesMsg += '**🔄 New Game Update(s):**\n';
      newUpdates.forEach(u => {
        updatesMsg += `• **${u.gameTitle}** – \`${u.version}\` (${u.date})\n`;
        if (u.description) updatesMsg += `  _${u.description.substring(0, 80)}${u.description.length > 80 ? '…' : ''}_\n`;
      });
      updatesMsg += '\n🔄 Check the website for download links and patch notes!';
    }

    // --- STATUS (new or changed projects) ---
    let statusMsg = '';
    if (newStatus.length > 0 || changedStatus.length > 0) {
      statusMsg += `${ROLE_STATUS}\n`;
      statusMsg += '**📊 Status Update(s):**\n';
      
      if (newStatus.length > 0) {
        statusMsg += '\n*New projects added:*\n';
        newStatus.forEach(p => statusMsg += `• **${p.name}** – ${p.status.toUpperCase()} (ETA: ${p.eta})\n`);
      }
      
      if (changedStatus.length > 0) {
        statusMsg += '\n*Status changes:*\n';
        changedStatus.forEach(p => {
          const prev = previous.status.find(s => s.name === p.name);
          statusMsg += `• **${p.name}** – ${prev.status} → ${p.status} | ETA: ${prev.eta} → ${p.eta}\n`;
        });
      }
      statusMsg += '\n📊 Check the Status page for more details!';
    }

    // ==============================
    // 5. Send to Discord (separate webhooks)
    // ==============================

    const webhookReleases = process.env.WEBHOOK_RELEASES;
    const webhookUpdates = process.env.WEBHOOK_UPDATES;
    const webhookStatus = process.env.WEBHOOK_STATUS;

    if (releaseMsg && webhookReleases) {
      await fetch(webhookReleases, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: releaseMsg })
      });
      console.log('✅ Release webhook sent.');
    }

    if (updatesMsg && webhookUpdates) {
      await fetch(webhookUpdates, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: updatesMsg })
      });
      console.log('✅ Update webhook sent.');
    }

    if (statusMsg && webhookStatus) {
      await fetch(webhookStatus, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: statusMsg })
      });
      console.log('✅ Status webhook sent.');
    }

    if (!releaseMsg && !updatesMsg && !statusMsg) {
      console.log('ℹ️ No changes detected. Nothing sent.');
    }

    // ==============================
    // 6. Save new state
    // ==============================
    const newState = {
      games: currentGames,
      updates: currentUpdates,
      status: currentStatus
    };
    fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

run();

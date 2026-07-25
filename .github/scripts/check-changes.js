const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

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
    const gamesData = eval(gameMatch[1]); // safe because we control the source

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

    // Also detect status changes (ETA/status updated for existing projects)
    const changedStatus = currentStatus.filter(p => {
      const prev = previous.status.find(s => s.name === p.name);
      if (!prev) return false;
      return prev.status !== p.status || prev.eta !== p.eta;
    });

    // ==============================
    // 4. Build messages
    // ==============================

    let releaseMsg = '';
    if (newGames.length > 0) {
      releaseMsg += '**🎮 New Release(s):**\n';
      newGames.forEach(g => releaseMsg += `• **${g.title}** (ID: ${g.id})\n`);
    }
    if (newUpdates.length > 0) {
      if (releaseMsg) releaseMsg += '\n';
      releaseMsg += '**🔄 New Update(s):**\n';
      newUpdates.forEach(u => {
        releaseMsg += `• **${u.gameTitle}** – \`${u.version}\` (${u.date})\n`;
        if (u.description) releaseMsg += `  _${u.description.substring(0, 80)}${u.description.length > 80 ? '…' : ''}_\n`;
      });
    }

    let statusMsg = '';
    if (newStatus.length > 0) {
      statusMsg += '**📊 New Status Project(s):**\n';
      newStatus.forEach(p => statusMsg += `• **${p.name}** – ${p.status.toUpperCase()} (ETA: ${p.eta})\n`);
    }
    if (changedStatus.length > 0) {
      if (statusMsg) statusMsg += '\n';
      statusMsg += '**🔄 Status Updated:**\n';
      changedStatus.forEach(p => {
        const prev = previous.status.find(s => s.name === p.name);
        statusMsg += `• **${p.name}** – ${prev.status} → ${p.status} | ETA: ${prev.eta} → ${p.eta}\n`;
      });
    }

    // ==============================
    // 5. Send to Discord
    // ==============================

    const webhookReleases = process.env.WEBHOOK_RELEASES;
    const webhookStatus = process.env.WEBHOOK_STATUS;

    if (releaseMsg && webhookReleases) {
      await fetch(webhookReleases, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: releaseMsg })
      });
      console.log('✅ Release webhook sent.');
    }

    if (statusMsg && webhookStatus) {
      await fetch(webhookStatus, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: statusMsg })
      });
      console.log('✅ Status webhook sent.');
    }

    if (!releaseMsg && !statusMsg) {
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

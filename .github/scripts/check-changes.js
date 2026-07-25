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
let previous = { games: [], updates: [], status: [], lastStatusMessageId: null };
if (fs.existsSync(stateFile)) {
  try {
    previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    console.log('📂 Loaded previous state.');
  } catch (e) {
    console.log('⚠️ Could not parse state.json, starting fresh.');
  }
} else {
  console.log('📂 No previous state found. Will treat everything as new.');
}

// ==============================
// 2. Fetch current data from live site
// ==============================
async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (status: ${res.status})`);
  return res.text();
}

async function run() {
  try {
    console.log('📡 Fetching script.js...');
    const scriptJs = await fetchFile('https://ghostreleases.com/script.js');
    console.log('✅ script.js fetched (length: ' + scriptJs.length + ' chars)');

    console.log('📡 Fetching status.html...');
    const statusHtml = await fetchFile('https://ghostreleases.com/status.html');
    console.log('✅ status.html fetched (length: ' + statusHtml.length + ' chars)');

    // --- Parse gamesData from script.js ---
    const gameMatch = scriptJs.match(/const gamesData = (\[[\s\S]*?\]);/);
    if (!gameMatch) throw new Error('Could not find gamesData in script.js');
    const gamesData = eval(gameMatch[1]);
    console.log('✅ Parsed gamesData: ' + gamesData.length + ' games');

    // --- Parse repackProjects from status.html ---
    const statusMatch = statusHtml.match(/const repackProjects = (\[[\s\S]*?\]);/);
    if (!statusMatch) throw new Error('Could not find repackProjects in status.html');
    const repackProjects = eval(statusMatch[1]);
    console.log('✅ Parsed repackProjects: ' + repackProjects.length + ' projects');

    // ==============================
    // 3. Detect changes
    // ==============================

    // 3a. New games (by id)
    const currentGames = gamesData.map(g => ({ id: g.id, title: g.title }));
    const newGames = currentGames.filter(g => !previous.games.some(p => p.id === g.id));
    console.log(`🔍 New games: ${newGames.length}`);
    if (newGames.length > 0) {
      console.log(`   New game titles: ${newGames.map(g => g.title).join(', ')}`);
    }

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
    console.log(`🔍 New updates: ${newUpdates.length}`);

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
    console.log(`🔍 New status: ${newStatus.length}`);
    if (newStatus.length > 0) {
      console.log(`   New status projects: ${newStatus.map(p => p.name).join(', ')}`);
    }

    // Status changes (ETA/status updated)
    const changedStatus = currentStatus.filter(p => {
      const prev = previous.status.find(s => s.name === p.name);
      if (!prev) return false;
      return prev.status !== p.status || prev.eta !== p.eta;
    });
    console.log(`🔍 Status changes: ${changedStatus.length}`);

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

    // --- Prepare new state for saving (we'll update lastStatusMessageId later) ---
    let newState = {
      games: currentGames,
      updates: currentUpdates,
      status: currentStatus,
      lastStatusMessageId: previous.lastStatusMessageId // will be updated if we send a new status message
    };

    // Send releases
    if (releaseMsg && webhookReleases) {
      console.log('📤 Sending releases webhook...');
      const res = await fetch(webhookReleases, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: releaseMsg })
      });
      if (res.ok) {
        console.log('✅ Release webhook sent.');
      } else {
        console.log(`⚠️ Release webhook responded with ${res.status}: ${await res.text()}`);
      }
    } else if (!releaseMsg) {
      console.log('ℹ️ No new releases to send.');
    } else {
      console.log('⚠️ No WEBHOOK_RELEASES secret found.');
    }

    // Send updates
    if (updatesMsg && webhookUpdates) {
      console.log('📤 Sending updates webhook...');
      const res = await fetch(webhookUpdates, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: updatesMsg })
      });
      if (res.ok) {
        console.log('✅ Update webhook sent.');
      } else {
        console.log(`⚠️ Update webhook responded with ${res.status}: ${await res.text()}`);
      }
    } else if (!updatesMsg) {
      console.log('ℹ️ No new updates to send.');
    } else {
      console.log('⚠️ No WEBHOOK_UPDATES secret found.');
    }

    // Send status (and delete previous message)
    if ((statusMsg) && webhookStatus) {
      // Delete previous status message if we have an ID
      if (previous.lastStatusMessageId) {
        try {
          const delRes = await fetch(`${webhookStatus}/messages/${previous.lastStatusMessageId}`, {
            method: 'DELETE'
          });
          if (delRes.ok) {
            console.log('🗑️ Deleted old status message');
          } else {
            console.log(`⚠️ Could not delete old status message: ${delRes.status}`);
          }
        } catch (e) {
          console.log('⚠️ Error deleting old status message:', e.message);
        }
      }

      // Send new status message
      console.log('📤 Sending status webhook...');
      const res = await fetch(webhookStatus, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: statusMsg })
      });
      if (res.ok) {
        // Try to get the message ID from the response
        try {
          const result = await res.json();
          if (result.id) {
            newState.lastStatusMessageId = result.id;
            console.log('✅ New status message sent and ID saved.');
          } else {
            console.log('✅ Status webhook sent, but no ID found in response.');
          }
        } catch (parseErr) {
          // If response is not JSON, just log success
          console.log('✅ Status webhook sent (response not JSON, no ID stored).');
        }
      } else {
        const errorText = await res.text();
        console.log(`❌ Status webhook responded with ${res.status}: ${errorText}`);
      }
    } else if (!statusMsg) {
      console.log('ℹ️ No status changes to send.');
      // No new status, but we keep the old ID in state (don't delete it)
    } else {
      console.log('⚠️ No WEBHOOK_STATUS secret found.');
    }

    // ==============================
    // 6. Save new state
    // ==============================
    fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
    console.log('💾 State saved.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

run();

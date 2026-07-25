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

// ==============================
// Helper: Send a single message to a webhook
// ==============================
async function sendWebhookMessage(webhookUrl, content) {
  const MAX_LENGTH = 2000;
  if (content.length <= MAX_LENGTH) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    return res;
  }
  // Split into chunks if too long
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, MAX_LENGTH);
    const newline = chunk.lastIndexOf('\n');
    if (newline > 0 && newline < chunk.length - 1) {
      chunk = chunk.slice(0, newline + 1);
    }
    remaining = remaining.slice(chunk.length);
    chunks.push(chunk);
  }
  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunks[i] })
    });
    if (!res.ok) return res;
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
  }
  return { ok: true };
}

// ==============================
// Helper: Build a detailed game message
// ==============================
function buildGameMessage(game) {
  let msg = `**${game.title}**\n`;
  msg += `> ${game.description}\n\n`;
  msg += `**Version:** ${game.VersionNumber || 'N/A'}\n`;
  msg += `**Original Size:** ${game.sizeBefore || 'N/A'}\n`;
  msg += `**Download Size:** ${game.sizeAfter || 'N/A'}\n`;
  msg += `**Cracked By:** ${game.cracker || 'N/A'}\n`;
  msg += `**Release Date:** ${game.releaseDate || 'N/A'}\n\n`;
  if (game.downloadParts && game.downloadParts.length > 0) {
    msg += `**Download Parts:**\n`;
    game.downloadParts.forEach(part => {
      let urls = '';
      if (part.mirrors && part.mirrors.length > 0) {
        urls = part.mirrors.map(m => `<${m.url}>`).join(' | ');
      } else if (part.url) {
        urls = `<${part.url}>`;
      }
      msg += `• ${part.name} (${part.size}) – ${urls}\n`;
    });
  }
  msg += `\n📥 **Download now on our website!**`;
  return msg;
}

// ==============================
// Helper: Build a detailed update message
// ==============================
function buildUpdateMessage(update, gameTitle) {
  let msg = `**${gameTitle} – ${update.version}**\n`;
  msg += `> ${update.description || 'No description provided.'}\n\n`;
  msg += `📅 Date: ${update.date}\n`;
  if (update.mirrors && update.mirrors.length > 0) {
    msg += `**Download Links:**\n`;
    update.mirrors.forEach(m => {
      msg += `• ${m.host}: <${m.url}>\n`;
    });
  } else if (update.downloadUrl) {
    msg += `**Download Link:** <${update.downloadUrl}>\n`;
  }
  if (update.steps && update.steps.length > 0) {
    msg += `\n**Installation Steps:**\n`;
    update.steps.forEach(step => msg += `• ${step}\n`);
  }
  msg += `\n🔄 Check the website for more details.`;
  return msg;
}

async function run() {
  try {
    console.log('📡 Fetching script.js...');
    const scriptJs = await fetchFile('https://ghostreleases.com/script.js');
    console.log('📡 Fetching status.html...');
    const statusHtml = await fetchFile('https://ghostreleases.com/status.html');

    // --- Parse gamesData ---
    const gameMatch = scriptJs.match(/const gamesData = (\[[\s\S]*?\]);/);
    if (!gameMatch) throw new Error('Could not find gamesData');
    const gamesData = eval(gameMatch[1]);
    console.log(`✅ Parsed gamesData: ${gamesData.length} games`);

    // --- Parse repackProjects ---
    const statusMatch = statusHtml.match(/const repackProjects = (\[[\s\S]*?\]);/);
    if (!statusMatch) throw new Error('Could not find repackProjects');
    const repackProjects = eval(statusMatch[1]);
    console.log(`✅ Parsed repackProjects: ${repackProjects.length} projects`);

    // ==============================
    // Detect changes
    // ==============================

    // New games (full objects)
    const newGames = gamesData.filter(g => !previous.games.some(p => p.id === g.id));
    console.log(`🔍 New games: ${newGames.length}`);

    // New updates (full objects)
    const newUpdates = [];
    gamesData.forEach(g => {
      const prevUpdates = previous.updates.filter(u => u.gameId === g.id);
      (g.updates || []).forEach(u => {
        if (!prevUpdates.some(p => p.version === u.version && p.gameId === g.id)) {
          newUpdates.push({ ...u, gameTitle: g.title });
        }
      });
    });
    console.log(`🔍 New updates: ${newUpdates.length}`);

    // Status changes
    const currentStatus = repackProjects.map(p => ({ name: p.name, status: p.status, eta: p.eta, details: p.details || '' }));
    const newStatus = currentStatus.filter(p => !previous.status.some(s => s.name === p.name));
    const changedStatus = currentStatus.filter(p => {
      const prev = previous.status.find(s => s.name === p.name);
      if (!prev) return false;
      return prev.status !== p.status || prev.eta !== p.eta;
    });
    console.log(`🔍 New status: ${newStatus.length}, Status changes: ${changedStatus.length}`);

    // ==============================
    // Send messages
    // ==============================

    const webhookReleases = process.env.WEBHOOK_RELEASES;
    const webhookUpdates = process.env.WEBHOOK_UPDATES;
    const webhookStatus = process.env.WEBHOOK_STATUS;

    // --- New Releases (one message per game) ---
    if (newGames.length > 0 && webhookReleases) {
      // Send the role mention first (once)
      await sendWebhookMessage(webhookReleases, ROLE_RELEASES + '\n**🎮 New Release(s):**');
      for (const game of newGames) {
        const msg = buildGameMessage(game);
        await sendWebhookMessage(webhookReleases, msg);
        await new Promise(r => setTimeout(r, 500)); // avoid rate limits
      }
      console.log(`✅ Sent ${newGames.length} release messages.`);
    } else if (newGames.length > 0) {
      console.log('⚠️ No WEBHOOK_RELEASES secret found.');
    } else {
      console.log('ℹ️ No new releases.');
    }

    // --- New Updates (one message per update) ---
    if (newUpdates.length > 0 && webhookUpdates) {
      await sendWebhookMessage(webhookUpdates, ROLE_UPDATES + '\n**🔄 New Update(s):**');
      for (const update of newUpdates) {
        const msg = buildUpdateMessage(update, update.gameTitle);
        await sendWebhookMessage(webhookUpdates, msg);
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`✅ Sent ${newUpdates.length} update messages.`);
    } else if (newUpdates.length > 0) {
      console.log('⚠️ No WEBHOOK_UPDATES secret found.');
    } else {
      console.log('ℹ️ No new updates.');
    }

    // --- Status (delete old, send new) ---
    if ((newStatus.length > 0 || changedStatus.length > 0) && webhookStatus) {
      // Delete previous status message
      if (previous.lastStatusMessageId) {
        try {
          const delRes = await fetch(`${webhookStatus}/messages/${previous.lastStatusMessageId}`, { method: 'DELETE' });
          if (delRes.ok) console.log('🗑️ Deleted old status message');
        } catch (e) { /* ignore */ }
      }
      // Build status message
      let statusMsg = `${ROLE_STATUS}\n**📊 Status Update(s):**\n`;
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
      // Send new status
      const res = await sendWebhookMessage(webhookStatus, statusMsg);
      if (res.ok && res.headers && res.headers.get('content-type')?.includes('json')) {
        const json = await res.json();
        previous.lastStatusMessageId = json.id; // will be saved in new state
      }
      console.log('✅ Status updated.');
    } else {
      console.log('ℹ️ No status changes.');
    }

    // ==============================
    // Save new state
    // ==============================
    const newState = {
      games: gamesData.map(g => ({ id: g.id, title: g.title })),
      updates: gamesData.flatMap(g => (g.updates || []).map(u => ({ gameId: g.id, version: u.version, date: u.date }))),
      status: currentStatus,
      lastStatusMessageId: previous.lastStatusMessageId || null
    };
    fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
    console.log('💾 State saved.');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

run();

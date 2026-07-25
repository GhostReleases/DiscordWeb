const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');

// ==============================
// CONFIG – ROLE IDs
// ==============================
const ROLE_RELEASES = '<@&1530516129158529175>';   
const ROLE_UPDATES = '<@&1530516105846587483>';    
const ROLE_STATUS = '<@&1530529602265550988>';    

// ==============================
// STATE LOADING
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
// FETCH HELPERS
// ==============================
async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (status: ${res.status})`);
  return res.text();
}

// ==============================
// WEBHOOK SENDER (with embed support)
// ==============================
async function sendWebhook(webhookUrl, content, embed = null) {
  const payload = {};
  if (content) payload.content = content;
  if (embed) payload.embeds = [embed];
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text();
    return { success: false, error: text };
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) { /* ignore */ }
  return { success: true, data };
}

// ==============================
// BUILD EMBEDS
// ==============================
function buildGameEmbed(game) {
  // Determine image: prefer steamAppId banner, fallback to game.image
  let imageUrl = null;
  if (game.steamAppId) {
    imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.steamAppId}/header.jpg`;
  }
  // If game.image is set and we have no Steam ID or if image is set and we want to use it (you can decide)
  // We'll use game.image if it exists and is not a default steamgriddb image (optional)
  // For simplicity: always use game.image if it's set, because you might have chosen a better one.
  if (game.image && game.image.startsWith('http')) {
    imageUrl = game.image;
  }

  const fields = [];
  if (game.VersionNumber) fields.push({ name: 'Version', value: game.VersionNumber, inline: true });
  if (game.cracker) fields.push({ name: 'Cracked By', value: game.cracker, inline: true });
  if (game.sizeBefore) fields.push({ name: 'Original Size', value: game.sizeBefore, inline: true });
  if (game.sizeAfter) fields.push({ name: 'Download Size', value: game.sizeAfter, inline: true });
  if (game.releaseDate) fields.push({ name: 'Release Date', value: game.releaseDate, inline: false });

  return {
    title: game.title,
    description: game.description ? game.description.slice(0, 4000) : 'No description available.',
    color: 0xb367d6,
    url: 'https://ghostreleases.com',
    fields: fields,
    image: imageUrl ? { url: imageUrl } : undefined,
    footer: { text: 'Ghost Releases' }
  };
}

function buildUpdateEmbed(update, gameTitle) {
  const fields = [];
  if (update.date) fields.push({ name: 'Date', value: update.date, inline: true });
  if (update.mirrors && update.mirrors.length > 0) {
    const links = update.mirrors.map(m => `[${m.host}](${m.url})`).join(' | ');
    fields.push({ name: 'Download Links', value: links, inline: false });
  } else if (update.downloadUrl) {
    fields.push({ name: 'Download Link', value: `[Download](${update.downloadUrl})`, inline: false });
  }
  if (update.steps && update.steps.length > 0) {
    const steps = update.steps.map((s, i) => `${i+1}. ${s}`).join('\n');
    fields.push({ name: 'Installation Steps', value: steps.slice(0, 1024), inline: false });
  }

  return {
    title: `${gameTitle} – ${update.version}`,
    description: update.description ? update.description.slice(0, 4000) : 'No patch notes provided.',
    color: 0xf0a030,
    url: 'https://ghostreleases.com',
    fields: fields,
    footer: { text: 'Ghost Releases' }
  };
}

// ==============================
// Helper to compute hash of downloadParts (for repack detection)
// ==============================
function hashDownloadParts(parts) {
  const str = JSON.stringify(parts.map(p => ({ name: p.name, size: p.size, mirrors: p.mirrors, url: p.url })));
  return crypto.createHash('md5').update(str).digest('hex');
}

// ==============================
// MAIN
// ==============================
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
    // DETECT CHANGES
    // ==============================

    // New games (by id)
    const newGames = gamesData.filter(g => !previous.games.some(p => p.id === g.id));
    // Also detect repack updates: games that exist but have different downloadParts hash
    const updatedRepacks = gamesData.filter(g => {
      const prev = previous.games.find(p => p.id === g.id);
      if (!prev) return false;
      const currentHash = hashDownloadParts(g.downloadParts || []);
      const prevHash = prev.downloadPartsHash || '';
      return currentHash !== prevHash;
    });
    console.log(`🔍 New games: ${newGames.length}, Updated repacks: ${updatedRepacks.length}`);

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
    // SEND WEBHOOKS
    // ==============================
    const webhookReleases = process.env.WEBHOOK_RELEASES;
    const webhookUpdates = process.env.WEBHOOK_UPDATES;
    const webhookStatus = process.env.WEBHOOK_STATUS;

    let newState = {
      games: gamesData.map(g => ({ id: g.id, title: g.title, downloadPartsHash: hashDownloadParts(g.downloadParts || []) })),
      updates: gamesData.flatMap(g => (g.updates || []).map(u => ({ gameId: g.id, version: u.version, date: u.date }))),
      status: currentStatus,
      lastStatusMessageId: previous.lastStatusMessageId
    };

    // --- RELEASES (new games + updated repacks) ---
    const allReleases = [...newGames, ...updatedRepacks];
    if (allReleases.length > 0 && webhookReleases) {
      // Send role ping + intro
      let intro = `${ROLE_RELEASES} **🎮 New Release(s):**`;
      if (updatedRepacks.length > 0) intro += `\n*Note: Some games have been repacked (download links changed).*`;
      await sendWebhook(webhookReleases, intro);
      for (const game of allReleases) {
        const embed = buildGameEmbed(game);
        try {
          await sendWebhook(webhookReleases, null, embed);
          console.log(`✅ Sent release embed for ${game.title}`);
        } catch (err) {
          console.log(`⚠️ Failed to send embed for ${game.title}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`✅ Sent ${allReleases.length} release embeds.`);
    } else if (allReleases.length > 0) {
      console.log('⚠️ No WEBHOOK_RELEASES secret.');
    } else {
      console.log('ℹ️ No new releases or repack updates.');
    }

    // --- UPDATES ---
    if (newUpdates.length > 0 && webhookUpdates) {
      await sendWebhook(webhookUpdates, `${ROLE_UPDATES} **🔄 New Update(s):**`);
      for (const update of newUpdates) {
        const embed = buildUpdateEmbed(update, update.gameTitle);
        try {
          await sendWebhook(webhookUpdates, null, embed);
          console.log(`✅ Sent update embed for ${update.gameTitle} – ${update.version}`);
        } catch (err) {
          console.log(`⚠️ Failed to send update for ${update.gameTitle}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`✅ Sent ${newUpdates.length} update embeds.`);
    } else if (newUpdates.length > 0) {
      console.log('⚠️ No WEBHOOK_UPDATES secret.');
    } else {
      console.log('ℹ️ No new updates.');
    }

    // --- STATUS (delete old, send new) ---
    if ((newStatus.length > 0 || changedStatus.length > 0) && webhookStatus) {
      // Delete previous message
      if (previous.lastStatusMessageId) {
        try {
          const delRes = await fetch(`${webhookStatus}/messages/${previous.lastStatusMessageId}`, { method: 'DELETE' });
          if (delRes.ok) console.log('🗑️ Deleted old status message');
          else console.log(`⚠️ Could not delete old status: ${delRes.status}`);
        } catch (e) {
          console.log('⚠️ Error deleting old status:', e.message);
        }
      }

      let statusText = `${ROLE_STATUS} **📊 Status Update(s):**\n`;
      if (newStatus.length > 0) {
        statusText += '\n*New projects added:*\n';
        newStatus.forEach(p => statusText += `• **${p.name}** – ${p.status.toUpperCase()} (ETA: ${p.eta})\n`);
      }
      if (changedStatus.length > 0) {
        statusText += '\n*Status changes:*\n';
        changedStatus.forEach(p => {
          const prev = previous.status.find(s => s.name === p.name);
          statusText += `• **${p.name}** – ${prev.status} → ${p.status} | ETA: ${prev.eta} → ${p.eta}\n`;
        });
      }
      statusText += '\n📊 Check the Status page for more details!';

      const result = await sendWebhook(webhookStatus, statusText);
      if (result.success && result.data.id) {
        newState.lastStatusMessageId = result.data.id;
        console.log('✅ New status sent and ID saved.');
      } else {
        console.log('⚠️ Status sent but ID not stored:', result.error || 'unknown');
      }
    } else {
      console.log('ℹ️ No status changes.');
    }

    // ==============================
    // SAVE STATE
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

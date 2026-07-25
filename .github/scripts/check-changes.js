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
// STATE
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
// HELPERS
// ==============================
async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (status: ${res.status})`);
  return res.text();
}

async function sendWebhook(webhookUrl, content, embed = null, wait = false) {
  const url = wait ? `${webhookUrl}?wait=true` : webhookUrl;
  const payload = { content, embeds: embed ? [embed] : [] };
  let res;
  let attempt = 0;
  const maxAttempts = 3;
  while (attempt < maxAttempts) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after')) * 1000 || 2000;
        console.log(`⏳ Rate limited, waiting ${retryAfter}ms...`);
        await new Promise(r => setTimeout(r, retryAfter));
        attempt++;
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        return { success: false, error: text };
      }
      let data = {};
      try { data = await res.json(); } catch (e) {}
      return { success: true, data };
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) return { success: false, error: e.message };
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

function buildGameEmbed(game) {
  // USE YOUR SITE IMAGE FIRST, fallback to Steam
  let imageUrl = null;
  if (game.image) {
    imageUrl = game.image;
  } else if (game.steamAppId) {
    imageUrl = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${game.steamAppId}/header.jpg`;
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
    url: `https://ghostreleases.com/game-${game.id}.html`,
    fields,
    image: imageUrl ? { url: imageUrl } : undefined,
    footer: { text: 'Ghost Releases' }
  };
}

function buildUpdateEmbed(update, gameTitle) {
  const fields = [];
  if (update.date) fields.push({ name: 'Date', value: update.date, inline: true });
  if (update.mirrors?.length) {
    const links = update.mirrors.map(m => `[${m.host}](${m.url})`).join(' | ');
    fields.push({ name: 'Download Links', value: links, inline: false });
  } else if (update.downloadUrl) {
    fields.push({ name: 'Download Link', value: `[Download](${update.downloadUrl})`, inline: false });
  }
  if (update.steps?.length) {
    const steps = update.steps.map((s, i) => `${i+1}. ${s}`).join('\n');
    fields.push({ name: 'Installation Steps', value: steps.slice(0, 1024), inline: false });
  }
  return {
    title: `${gameTitle} – ${update.version}`,
    description: update.description ? update.description.slice(0, 4000) : 'No patch notes provided.',
    color: 0xf0a030,
    url: `https://ghostreleases.com/game-${update.gameId}.html`,
    fields,
    footer: { text: 'Ghost Releases' }
  };
}

function getDownloadHash(game) {
  const parts = game.downloadParts || [];
  return JSON.stringify(parts.map(p => ({ name: p.name, size: p.size, urls: (p.mirrors || []).map(m => m.url).concat(p.url || []).sort() })));
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

    const gameMatch = scriptJs.match(/const gamesData = (\[[\s\S]*?\]);/);
    if (!gameMatch) throw new Error('Could not find gamesData');
    const gamesData = eval(gameMatch[1]);
    console.log(`✅ Parsed gamesData: ${gamesData.length} games`);

    const statusMatch = statusHtml.match(/const repackProjects = (\[[\s\S]*?\]);/);
    if (!statusMatch) throw new Error('Could not find repackProjects');
    const repackProjects = eval(statusMatch[1]);
    console.log(`✅ Parsed repackProjects: ${repackProjects.length} projects`);

    // ==============================
    // DETECT CHANGES
    // ==============================
    const newGames = gamesData.filter(g => !previous.games.some(p => p.id === g.id));
    console.log(`🔍 New games: ${newGames.length}`);

    const updatedRepacks = gamesData.filter(g => {
      const prev = previous.games.find(p => p.id === g.id);
      if (!prev) return false;
      return prev.downloadHash !== getDownloadHash(g);
    });
    console.log(`🔍 Updated repacks: ${updatedRepacks.length}`);

    const newUpdates = [];
    gamesData.forEach(g => {
      const prevUpdates = previous.updates.filter(u => u.gameId === g.id);
      (g.updates || []).forEach(u => {
        if (!prevUpdates.some(p => p.version === u.version && p.gameId === g.id)) {
          newUpdates.push({ ...u, gameTitle: g.title, gameId: g.id });
        }
      });
    });
    console.log(`🔍 New updates: ${newUpdates.length}`);

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
      games: gamesData.map(g => ({ id: g.id, title: g.title, downloadHash: getDownloadHash(g) })),
      updates: gamesData.flatMap(g => (g.updates || []).map(u => ({ gameId: g.id, version: u.version, date: u.date }))),
      status: currentStatus,
      lastStatusMessageId: previous.lastStatusMessageId
    };

    // --- RELEASES ---
    const releaseItems = [...newGames, ...updatedRepacks];
    if (releaseItems.length > 0 && webhookReleases) {
      await sendWebhook(webhookReleases, `${ROLE_RELEASES} **🎮 New Release(s):**`);
      for (const game of releaseItems) {
        const isUpdate = updatedRepacks.includes(game);
        const embed = buildGameEmbed(game);
        if (isUpdate) {
          embed.description = (embed.description || '') + '\n\n🔄 **This repack has been updated** – new download parts available!';
        }
        const result = await sendWebhook(webhookReleases, null, embed);
        if (result.success) console.log(`✅ Sent release embed for ${game.title}`);
        else console.log(`❌ Failed to send release for ${game.title}: ${result.error}`);
        await new Promise(r => setTimeout(r, 800));
      }
      console.log(`✅ Sent ${releaseItems.length} release embeds.`);
    } else {
      console.log('ℹ️ No new releases or updated repacks.');
    }

    // --- UPDATES ---
    if (newUpdates.length > 0 && webhookUpdates) {
      await sendWebhook(webhookUpdates, `${ROLE_UPDATES} **🔄 New Update(s):**`);
      for (const update of newUpdates) {
        const embed = buildUpdateEmbed(update, update.gameTitle);
        const result = await sendWebhook(webhookUpdates, null, embed);
        if (result.success) console.log(`✅ Sent update embed for ${update.gameTitle}`);
        else console.log(`❌ Failed to send update for ${update.gameTitle}: ${result.error}`);
        await new Promise(r => setTimeout(r, 800));
      }
      console.log(`✅ Sent ${newUpdates.length} update embeds.`);
    } else {
      console.log('ℹ️ No new updates.');
    }

    // --- STATUS (delete old + send new) ---
    if ((newStatus.length > 0 || changedStatus.length > 0) && webhookStatus) {
      // Delete old status message
      if (previous.lastStatusMessageId) {
        try {
          const delRes = await fetch(`${webhookStatus}/messages/${previous.lastStatusMessageId}`, { method: 'DELETE' });
          if (delRes.ok) {
            console.log('🗑️ Deleted old status message');
            // Clear the stored ID so we don't try to delete again
            previous.lastStatusMessageId = null;
          } else {
            console.log(`⚠️ Could not delete old status: ${delRes.status}`);
          }
        } catch (e) {
          console.log('⚠️ Error deleting old status:', e.message);
        }
      }

      // Build status message
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

      // Send new status with ?wait=true to get the message ID
      const result = await sendWebhook(webhookStatus, statusText, null, true);
      if (result.success && result.data && result.data.id) {
        newState.lastStatusMessageId = result.data.id;
        console.log('✅ New status sent and ID saved.');
      } else {
        console.log('⚠️ Status sent but ID not stored:', result.error || 'unknown');
        // If the webhook didn't return an ID, don't store one
        newState.lastStatusMessageId = null;
      }
    } else {
      console.log('ℹ️ No status changes.');
    }

    // ==============================
    // SAVE STATE
    // ==============================
    // Ensure the directory exists
    const stateDir = path.dirname(stateFile);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    fs.writeFileSync(stateFile, JSON.stringify(newState, null, 2));
    console.log('💾 State saved to:', stateFile);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

run();

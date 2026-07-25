const fs = require('fs');
const path = require('path');

// Load the previous state (if any)
const stateFile = path.join(__dirname, '../../state.json');
let previousState = { games: [], updates: [] };
if (fs.existsSync(stateFile)) {
  previousState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// Read the current script.js and extract gamesData
const scriptContent = fs.readFileSync('script.js', 'utf8');
// Extract the array – simple regex (works if gamesData is the first array)
const match = scriptContent.match(/const gamesData = (\[[\s\S]*?\]);/);
if (!match) {
  console.error('Could not find gamesData');
  process.exit(1);
}
const gamesData = eval(match[1]); // be careful, but this is a trusted file

// Collect game titles and update versions
const current = {
  games: gamesData.map(g => ({ id: g.id, title: g.title })),
  updates: gamesData.flatMap(g => 
    (g.updates || []).map(u => ({ gameId: g.id, version: u.version, date: u.date }))
  )
};

// Find new games
const newGames = current.games.filter(g => !previousState.games.some(p => p.id === g.id));
// Find new updates (based on version + date)
const newUpdates = current.updates.filter(u => 
  !previousState.updates.some(p => p.version === u.version && p.gameId === u.gameId)
);

if (newGames.length === 0 && newUpdates.length === 0) {
  console.log('No changes detected.');
  process.exit(0);
}

// Prepare Discord message
let message = '';
if (newGames.length > 0) {
  message += `**🎮 New Release(s):**\n`;
  newGames.forEach(g => message += `• **${g.title}** (ID: ${g.id})\n`);
}
if (newUpdates.length > 0) {
  message += `\n**🔄 New Update(s):**\n`;
  newUpdates.forEach(u => {
    const game = gamesData.find(g => g.id === u.gameId);
    message += `• **${game.title}** – version ${u.version} (${u.date})\n`;
  });
}

// Send to Discord webhook
const webhookUrl = process.env.DISCORD_WEBHOOK;
if (webhookUrl) {
  const fetch = require('node-fetch');
  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: message })
  });
}

// Update state file
fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));

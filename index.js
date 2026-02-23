const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Reaction]
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_CHANNEL_ID = process.env.SOURCE_CHANNEL_ID;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const EMOJIS = (process.env.EMOJIS || '🤣,😂').split(',').map(e => e.trim());

// Fichier pour persister les données
const DATA_DIR = '/data';
const DATA_FILE = `${DATA_DIR}/data.json`;

// Créer le dossier s'il n'existe pas
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.log('⚠️ Impossible de créer /data - les données ne seront pas persistées');
  }
}

// Stockage des messages collectés (id -> data)
let collectedMessages = new Map();
// Set des messages déjà envoyés dans le salon destination
let alreadySentIds = new Set();

// Compteur pour détecter les lancements multiples
let scanCount = 0;

// Sauvegarder les données dans un fichier
function saveData() {
  try {
    const data = {
      collectedMessages: [...collectedMessages.entries()],
      alreadySentIds: [...alreadySentIds],
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Données sauvegardées (${collectedMessages.size} messages)`);
  } catch (error) {
    console.error('❌ Erreur sauvegarde:', error.message);
  }
}

// Charger les données depuis le fichier
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      collectedMessages = new Map(data.collectedMessages || []);
      alreadySentIds = new Set(data.alreadySentIds || []);
      console.log(`📂 Données chargées: ${collectedMessages.size} messages, sauvegardé le ${data.savedAt}`);
      return true;
    }
  } catch (error) {
    console.error('❌ Erreur chargement:', error.message);
  }
  return false;
}

// Handlers pour détecter les crashs
process.on('uncaughtException', (error) => {
  console.error('💥 CRASH - uncaughtException:', error);
  saveData();
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 CRASH - unhandledRejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM reçu - arrêt du bot');
  saveData();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('⚠️ SIGINT reçu - arrêt du bot');
  saveData();
  process.exit(0);
});

client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`📥 Source: ${SOURCE_CHANNEL_ID}`);
  console.log(`📤 Destination: ${TARGET_CHANNEL_ID}`);
  console.log(`😂 Émojis: ${EMOJIS.join(', ')}`);

  // Charger les données persistées
  const hasData = loadData();

  // Enregistrer les slash commands
  await registerCommands();

  // Scanner seulement si pas de données chargées
  if (!hasData || collectedMessages.size === 0) {
    // Scanner le salon destination pour récupérer les messages déjà envoyés
    await loadAlreadySent();

    // Scanner l'historique source
    await scanHistory();
  } else {
    console.log('⏭️ Scan ignoré - données déjà chargées depuis le fichier');
  }

  // Sauvegarder périodiquement (toutes les 5 minutes)
  setInterval(saveData, 5 * 60 * 1000);
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('ltop')
      .setDescription(`Affiche le top des messages avec le plus de réactions`)
      .addIntegerOption(option =>
        option.setName('nombre')
          .setDescription('Nombre de messages à afficher (1-10)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10)),
    new SlashCommandBuilder()
      .setName('lrandom')
      .setDescription(`Affiche un message aléatoire parmi ceux collectés`),
    new SlashCommandBuilder()
      .setName('lscan')
      .setDescription(`Force un rescan complet du salon (admin only)`)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    console.log('🔧 Enregistrement des commandes slash...');

    // Supprimer les anciennes commandes globales
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    console.log('🗑️ Anciennes commandes globales supprimées');

    // Enregistrer par guild pour que ce soit instantané
    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
      console.log(`✅ Commandes enregistrées sur ${guild.name}`);
    }
  } catch (error) {
    console.error('❌ Erreur enregistrement commandes:', error.message);
    console.error(error);
  }
}

// Scan le salon destination pour récupérer les IDs déjà envoyés
async function loadAlreadySent() {
  console.log('🔍 Chargement des messages déjà envoyés...');

  try {
    const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!targetChannel) {
      console.log('❌ Salon destination introuvable');
      return;
    }

    let lastMessageId = null;
    let totalLoaded = 0;
    let batchCount = 0;

    while (true) {
      const options = { limit: 100 };
      if (lastMessageId) options.before = lastMessageId;

      const messages = await targetChannel.messages.fetch(options);
      batchCount++;
      console.log(`📦 Batch ${batchCount}: ${messages.size} messages récupérés`);

      if (messages.size === 0) break;

      for (const msg of messages.values()) {
        // Chercher l'ID du message original dans le bouton "Voir le message"
        if (msg.components && msg.components.length > 0) {
          const button = msg.components[0]?.components?.find(c => c.url);
          if (button && button.url) {
            // URL format: https://discord.com/channels/GUILD/CHANNEL/MESSAGE_ID
            const parts = button.url.split('/');
            const originalId = parts[parts.length - 1];
            if (originalId) {
              alreadySentIds.add(originalId);
              totalLoaded++;
            }
          }
        }
      }

      lastMessageId = messages.last().id;

      // Pause pour permettre au bot de répondre aux commandes
      await sleep(50);
    }

    console.log(`✅ ${totalLoaded} messages déjà envoyés chargés (seront ignorés)`);
  } catch (error) {
    console.error('❌ Erreur lors du chargement:', error.message);
  }
}

async function scanHistory() {
  scanCount++;
  console.log(`🔍 Scan de l'historique source en cours... (scan #${scanCount})`);

  if (scanCount > 1) {
    console.error('⚠️ ATTENTION: Le scan a été lancé plusieurs fois! Quelque chose ne va pas.');
  }

  const sourceChannel = await client.channels.fetch(SOURCE_CHANNEL_ID);
  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);

  if (!sourceChannel || !targetChannel) {
    console.error('❌ Impossible de trouver les salons');
    return;
  }

  let lastMessageId = null;
  let totalFound = 0;
  let totalSkipped = 0;
  let batchNum = 0;

  while (true) {
    const options = { limit: 100 };
    if (lastMessageId) options.before = lastMessageId;

    const messages = await sourceChannel.messages.fetch(options);
    if (messages.size === 0) break;

    batchNum++;

    for (const message of messages.values()) {
      const reaction = message.reactions.cache.find(r => EMOJIS.includes(r.emoji.name));

      if (reaction && reaction.count >= 1) {
        // Vérifier si déjà envoyé
        if (alreadySentIds.has(message.id)) {
          // Juste stocker pour les commandes, sans renvoyer
          await storeMessage(message, reaction.count, reaction.emoji.name);
          totalSkipped++;
          continue;
        }

        // Stocker et envoyer
        await storeMessage(message, reaction.count, reaction.emoji.name);
        await sendToTarget(message, targetChannel, reaction.count, reaction.emoji.name);
        alreadySentIds.add(message.id);
        totalFound++;
        // Petit délai pour éviter le rate limit
        await sleep(500);
      }
    }

    lastMessageId = messages.last().id;
    console.log(`📜 Batch ${batchNum}: scanné ${messages.size} msgs (${collectedMessages.size} collectés, ${totalFound} nouveaux, ${totalSkipped} ignorés)`);

    // Sauvegarder toutes les 10 batches
    if (batchNum % 10 === 0) {
      saveData();
    }

    // Pause pour permettre au bot de répondre aux commandes pendant le scan
    await sleep(100);
  }

  console.log(`✅ Scan terminé! ${totalFound} nouveaux messages envoyés, ${totalSkipped} déjà présents`);
  saveData();
}

async function storeMessage(message, reactionCount, emoji) {
  // Récupérer le message cité si c'est une réponse
  let replyTo = null;
  if (message.reference && message.reference.messageId) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      replyTo = {
        authorTag: repliedMsg.author.tag,
        content: repliedMsg.content?.substring(0, 200) || '*[Pas de texte]*'
      };
    } catch (e) {
      // Message original supprimé
    }
  }

  collectedMessages.set(message.id, {
    id: message.id,
    authorTag: message.author.tag,
    authorAvatar: message.author.displayAvatarURL(),
    content: message.content,
    url: message.url,
    channelName: message.channel.name,
    createdAt: message.createdAt,
    reactionCount: reactionCount,
    emoji: emoji,
    image: message.attachments.find(a => a.contentType?.startsWith('image/'))?.url || null,
    replyTo: replyTo
  });
}

function createEmbed(msgData) {
  let description = '';

  // Ajouter le message cité si présent
  if (msgData.replyTo) {
    description += `> **↩️ ${msgData.replyTo.authorTag}**\n`;
    description += `> ${msgData.replyTo.content.split('\n').join('\n> ')}\n\n`;
  }

  description += msgData.content || '*[Pas de texte]*';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: msgData.authorTag,
      iconURL: msgData.authorAvatar
    })
    .setDescription(description)
    .setColor(0xFFD700)
    .setTimestamp(new Date(msgData.createdAt))
    .setFooter({ text: `${msgData.emoji} ${msgData.reactionCount} | #${msgData.channelName}` });

  if (msgData.image) {
    embed.setImage(msgData.image);
  }

  return embed;
}

async function sendToTarget(message, targetChannel, reactionCount, emoji) {
  let description = '';

  // Ajouter le message cité si c'est une réponse
  if (message.reference && message.reference.messageId) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      description += `> **↩️ ${repliedMsg.author.tag}**\n`;
      description += `> ${repliedMsg.content?.substring(0, 200).split('\n').join('\n> ') || '*[Pas de texte]*'}\n\n`;
    } catch (e) {
      // Message original supprimé
    }
  }

  description += message.content || '*[Pas de texte]*';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: message.author.tag,
      iconURL: message.author.displayAvatarURL()
    })
    .setDescription(description)
    .setColor(0xFFD700)
    .setTimestamp(message.createdAt)
    .setFooter({ text: `${emoji} ${reactionCount} | #${message.channel.name}` });

  const image = message.attachments.find(a => a.contentType?.startsWith('image/'));
  if (image) {
    embed.setImage(image.url);
  }

  await targetChannel.send({
    embeds: [embed],
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,
        label: 'Voir le message',
        url: message.url
      }]
    }]
  });
}

// Handler des slash commands
console.log('🔌 Listener interactionCreate attaché');
client.on('interactionCreate', async (interaction) => {
  console.log(`🎮 Interaction reçue: ${interaction.type} - ${interaction.commandName || 'N/A'}`);

  if (!interaction.isChatInputCommand()) return;

  console.log(`📝 Commande slash reçue: /${interaction.commandName}`);

  if (interaction.commandName === 'ltop') {
    const nombre = interaction.options.getInteger('nombre');
    console.log(`🏆 /ltop ${nombre} exécutée - ${collectedMessages.size} messages en mémoire`);

    if (collectedMessages.size === 0) {
      await interaction.reply({ content: `Aucun message collecté pour le moment.`, ephemeral: true });
      return;
    }

    // Trier par nombre de réactions et prendre le top N
    const topMessages = [...collectedMessages.values()]
      .sort((a, b) => b.reactionCount - a.reactionCount)
      .slice(0, nombre);

    // Envoyer chaque message avec son bouton
    await interaction.reply({ content: `## 🏆 Top ${nombre}` });

    for (let i = 0; i < topMessages.length; i++) {
      const msgData = topMessages[i];
      const embed = createEmbed(msgData);
      embed.setTitle(`#${i + 1}`);

      await interaction.channel.send({
        embeds: [embed],
        components: [{
          type: 1,
          components: [{
            type: 2,
            style: 5,
            label: 'Voir le message',
            url: msgData.url
          }]
        }]
      });
    }
  }

  if (interaction.commandName === 'lrandom') {
    console.log(`🎲 /lrandom exécutée - ${collectedMessages.size} messages en mémoire`);
    if (collectedMessages.size === 0) {
      await interaction.reply({ content: `Aucun message collecté pour le moment.`, ephemeral: true });
      return;
    }

    // Prendre un message aléatoire
    const messagesArray = [...collectedMessages.values()];
    const randomMsg = messagesArray[Math.floor(Math.random() * messagesArray.length)];

    const embed = createEmbed(randomMsg);

    await interaction.reply({
      content: `## 🎲 Message aléatoire`,
      embeds: [embed],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: 'Voir le message',
          url: randomMsg.url
        }]
      }]
    });
  }

  if (interaction.commandName === 'lscan') {
    const ADMIN_ID = '221371104046874625';

    if (interaction.user.id !== ADMIN_ID) {
      await interaction.reply({ content: `❌ Tu n'as pas la permission d'utiliser cette commande.`, ephemeral: true });
      return;
    }

    console.log(`🔄 /lscan exécutée par ${interaction.user.tag}`);
    await interaction.reply({ content: `🔄 Rescan en cours... (${collectedMessages.size} messages actuellement)`, ephemeral: true });

    // Reset le compteur de scan
    scanCount = 0;

    // Recharger les IDs déjà envoyés
    await loadAlreadySent();

    // Relancer le scan
    await scanHistory();

    await interaction.followUp({ content: `✅ Rescan terminé! ${collectedMessages.size} messages collectés.`, ephemeral: true });
  }
});

// Surveillance en temps réel des nouvelles réactions
client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.message.channelId !== SOURCE_CHANNEL_ID) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Erreur fetch reaction:', error);
      return;
    }
  }

  if (!EMOJIS.includes(reaction.emoji.name)) return;

  // Mettre à jour le compteur si déjà collecté
  if (collectedMessages.has(reaction.message.id)) {
    const existing = collectedMessages.get(reaction.message.id);
    existing.reactionCount = reaction.count;
    console.log(`🔄 Compteur mis à jour pour ${reaction.message.id}: ${reaction.count} réactions`);
    saveData();
    return;
  }

  // Nouveau message à collecter
  const message = reaction.message;
  if (message.partial) {
    try {
      await message.fetch();
    } catch (error) {
      console.error('Erreur fetch message:', error);
      return;
    }
  }

  await storeMessage(message, reaction.count, reaction.emoji.name);

  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
  await sendToTarget(message, targetChannel, reaction.count, reaction.emoji.name);
  alreadySentIds.add(message.id);

  console.log(`📨 Nouveau message collecté de ${message.author.tag}`);
  saveData();
});

// Surveillance en temps réel des réactions retirées
client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.message.channelId !== SOURCE_CHANNEL_ID) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      // La réaction n'existe peut-être plus
      return;
    }
  }

  if (!EMOJIS.includes(reaction.emoji.name)) return;

  // Vérifier si le message est dans notre collection
  if (!collectedMessages.has(reaction.message.id)) return;

  const existing = collectedMessages.get(reaction.message.id);

  if (reaction.count === 0) {
    // Plus aucune réaction de cet emoji, supprimer de la DB
    collectedMessages.delete(reaction.message.id);
    console.log(`🗑️ Message ${reaction.message.id} retiré de la DB (0 réactions)`);
  } else {
    // Mettre à jour le compteur
    existing.reactionCount = reaction.count;
    console.log(`🔄 Compteur mis à jour pour ${reaction.message.id}: ${reaction.count} réactions`);
  }

  saveData();
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Serveur HTTP pour télécharger data.json
const http = require('http');
const HTTP_PORT = process.env.HTTP_PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/download') {
    if (!fs.existsSync(DATA_FILE)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'data.json not found' }));
      return;
    }
    const file = fs.readFileSync(DATA_FILE);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="data.json"'
    });
    res.end(file);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP server listening on port ${HTTP_PORT} — GET /download`);
});

client.login(BOT_TOKEN);

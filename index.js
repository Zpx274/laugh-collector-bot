const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');

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
const EMOJI = process.env.EMOJI || '🤣';

// Stockage des messages collectés (id -> data)
const collectedMessages = new Map();
// Set des messages déjà envoyés dans le salon destination
const alreadySentIds = new Set();

client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`📥 Source: ${SOURCE_CHANNEL_ID}`);
  console.log(`📤 Destination: ${TARGET_CHANNEL_ID}`);
  console.log(`😂 Émoji: ${EMOJI}`);

  // Enregistrer les slash commands
  await registerCommands();

  // Scanner le salon destination pour récupérer les messages déjà envoyés
  await loadAlreadySent();

  // Scanner l'historique source
  await scanHistory();
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('ltop')
      .setDescription(`Affiche le top des messages avec le plus de ${EMOJI}`)
      .addIntegerOption(option =>
        option.setName('nombre')
          .setDescription('Nombre de messages à afficher (1-10)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10)),
    new SlashCommandBuilder()
      .setName('lrandom')
      .setDescription(`Affiche un message aléatoire parmi ceux avec ${EMOJI}`)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    console.log('🔧 Enregistrement des commandes slash...');
    const result = await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ Commandes /ltop et /lrandom enregistrées!`);
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
  console.log('🔍 Scan de l\'historique source en cours...');

  const sourceChannel = await client.channels.fetch(SOURCE_CHANNEL_ID);
  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);

  if (!sourceChannel || !targetChannel) {
    console.error('❌ Impossible de trouver les salons');
    return;
  }

  let lastMessageId = null;
  let totalFound = 0;
  let totalSkipped = 0;

  while (true) {
    const options = { limit: 100 };
    if (lastMessageId) options.before = lastMessageId;

    const messages = await sourceChannel.messages.fetch(options);
    if (messages.size === 0) break;

    for (const message of messages.values()) {
      const reaction = message.reactions.cache.find(r => r.emoji.name === EMOJI);

      if (reaction && reaction.count >= 1) {
        // Vérifier si déjà envoyé
        if (alreadySentIds.has(message.id)) {
          // Juste stocker pour les commandes, sans renvoyer
          await storeMessage(message, reaction.count);
          totalSkipped++;
          continue;
        }

        // Stocker et envoyer
        await storeMessage(message, reaction.count);
        await sendToTarget(message, targetChannel, reaction.count);
        alreadySentIds.add(message.id);
        totalFound++;
        // Petit délai pour éviter le rate limit
        await sleep(500);
      }
    }

    lastMessageId = messages.last().id;
    console.log(`📜 Scanné ${messages.size} messages... (${collectedMessages.size} collectés)`);

    // Pause pour permettre au bot de répondre aux commandes pendant le scan
    await sleep(100);
  }

  console.log(`✅ Scan terminé! ${totalFound} nouveaux messages envoyés, ${totalSkipped} déjà présents`);
}

async function storeMessage(message, reactionCount) {
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
    .setTimestamp(msgData.createdAt)
    .setFooter({ text: `${EMOJI} ${msgData.reactionCount} | #${msgData.channelName}` });

  if (msgData.image) {
    embed.setImage(msgData.image);
  }

  return embed;
}

async function sendToTarget(message, targetChannel, reactionCount) {
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
    .setFooter({ text: `${EMOJI} ${reactionCount} | #${message.channel.name}` });

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
      await interaction.reply({ content: `Aucun message avec ${EMOJI} collecté pour le moment.`, ephemeral: true });
      return;
    }

    // Trier par nombre de réactions et prendre le top N
    const topMessages = [...collectedMessages.values()]
      .sort((a, b) => b.reactionCount - a.reactionCount)
      .slice(0, nombre);

    // Envoyer chaque message avec son bouton
    await interaction.reply({ content: `## 🏆 Top ${nombre} des messages avec ${EMOJI}` });

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
      await interaction.reply({ content: `Aucun message avec ${EMOJI} collecté pour le moment.`, ephemeral: true });
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

  if (reaction.emoji.name !== EMOJI) return;

  // Mettre à jour le compteur si déjà collecté
  if (collectedMessages.has(reaction.message.id)) {
    const existing = collectedMessages.get(reaction.message.id);
    existing.reactionCount = reaction.count;
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

  await storeMessage(message, reaction.count);

  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
  await sendToTarget(message, targetChannel, reaction.count);
  alreadySentIds.add(message.id);

  console.log(`📨 Nouveau message collecté de ${message.author.tag}`);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.login(BOT_TOKEN);

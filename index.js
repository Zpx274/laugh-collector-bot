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

client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`📥 Source: ${SOURCE_CHANNEL_ID}`);
  console.log(`📤 Destination: ${TARGET_CHANNEL_ID}`);
  console.log(`😂 Émoji: ${EMOJI}`);

  // Enregistrer les slash commands
  await registerCommands();

  // Scanner l'historique au démarrage
  await scanHistory();
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('top5')
      .setDescription(`Affiche le top 5 des messages avec le plus de ${EMOJI}`),
    new SlashCommandBuilder()
      .setName('random')
      .setDescription(`Affiche un message aléatoire parmi ceux avec ${EMOJI}`)
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

  try {
    console.log('🔧 Enregistrement des commandes slash...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Commandes /top5 et /random enregistrées!');
  } catch (error) {
    console.error('Erreur enregistrement commandes:', error);
  }
}

async function scanHistory() {
  console.log('🔍 Scan de l\'historique en cours...');

  const sourceChannel = await client.channels.fetch(SOURCE_CHANNEL_ID);
  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);

  if (!sourceChannel || !targetChannel) {
    console.error('❌ Impossible de trouver les salons');
    return;
  }

  let lastMessageId = null;
  let totalFound = 0;

  while (true) {
    const options = { limit: 100 };
    if (lastMessageId) options.before = lastMessageId;

    const messages = await sourceChannel.messages.fetch(options);
    if (messages.size === 0) break;

    for (const message of messages.values()) {
      const reaction = message.reactions.cache.find(r => r.emoji.name === EMOJI);

      if (reaction && reaction.count >= 1 && !collectedMessages.has(message.id)) {
        // Stocker les infos du message
        storeMessage(message, reaction.count);

        // Envoyer dans le salon destination
        await sendToTarget(message, targetChannel, reaction.count);
        totalFound++;
        // Petit délai pour éviter le rate limit
        await sleep(500);
      }
    }

    lastMessageId = messages.last().id;
    console.log(`📜 Scanné ${messages.size} messages...`);
  }

  console.log(`✅ Scan terminé! ${totalFound} messages trouvés avec ${EMOJI}`);
}

function storeMessage(message, reactionCount) {
  collectedMessages.set(message.id, {
    id: message.id,
    authorTag: message.author.tag,
    authorAvatar: message.author.displayAvatarURL(),
    content: message.content,
    url: message.url,
    channelName: message.channel.name,
    createdAt: message.createdAt,
    reactionCount: reactionCount,
    image: message.attachments.find(a => a.contentType?.startsWith('image/'))?.url || null
  });
}

function createEmbed(msgData) {
  const embed = new EmbedBuilder()
    .setAuthor({
      name: msgData.authorTag,
      iconURL: msgData.authorAvatar
    })
    .setDescription(msgData.content || '*[Pas de texte]*')
    .setColor(0xFFD700)
    .setTimestamp(msgData.createdAt)
    .setFooter({ text: `${EMOJI} ${msgData.reactionCount} | #${msgData.channelName}` });

  if (msgData.image) {
    embed.setImage(msgData.image);
  }

  return embed;
}

async function sendToTarget(message, targetChannel, reactionCount) {
  const embed = new EmbedBuilder()
    .setAuthor({
      name: message.author.tag,
      iconURL: message.author.displayAvatarURL()
    })
    .setDescription(message.content || '*[Pas de texte]*')
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
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'top5') {
    if (collectedMessages.size === 0) {
      await interaction.reply({ content: `Aucun message avec ${EMOJI} collecté pour le moment.`, ephemeral: true });
      return;
    }

    // Trier par nombre de réactions et prendre le top 5
    const top5 = [...collectedMessages.values()]
      .sort((a, b) => b.reactionCount - a.reactionCount)
      .slice(0, 5);

    const embeds = top5.map((msgData, index) => {
      const embed = createEmbed(msgData);
      embed.setTitle(`#${index + 1}`);
      return embed;
    });

    await interaction.reply({
      content: `## 🏆 Top 5 des messages avec ${EMOJI}`,
      embeds: embeds
    });
  }

  if (interaction.commandName === 'random') {
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

  storeMessage(message, reaction.count);

  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
  await sendToTarget(message, targetChannel, reaction.count);

  console.log(`📨 Nouveau message collecté de ${message.author.tag}`);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.login(BOT_TOKEN);

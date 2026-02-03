const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

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

// Set pour tracker les messages déjà envoyés (évite les doublons)
const sentMessages = new Set();

client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  console.log(`📥 Source: ${SOURCE_CHANNEL_ID}`);
  console.log(`📤 Destination: ${TARGET_CHANNEL_ID}`);
  console.log(`😂 Émoji: ${EMOJI}`);

  // Scanner l'historique au démarrage
  await scanHistory();
});

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

      if (reaction && reaction.count >= 1 && !sentMessages.has(message.id)) {
        await sendToTarget(message, targetChannel, reaction.count);
        sentMessages.add(message.id);
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

  // Ajouter la première image si présente
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

// Surveillance en temps réel des nouvelles réactions
client.on('messageReactionAdd', async (reaction, user) => {
  // Ignorer si pas le bon salon
  if (reaction.message.channelId !== SOURCE_CHANNEL_ID) return;

  // Fetch si partial
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Erreur fetch reaction:', error);
      return;
    }
  }

  // Vérifier si c'est le bon emoji
  if (reaction.emoji.name !== EMOJI) return;

  // Vérifier si déjà envoyé
  if (sentMessages.has(reaction.message.id)) return;

  const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
  await sendToTarget(reaction.message, targetChannel, reaction.count);
  sentMessages.add(reaction.message.id);

  console.log(`📨 Nouveau message collecté de ${reaction.message.author.tag}`);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

client.login(BOT_TOKEN);

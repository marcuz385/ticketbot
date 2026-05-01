const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  Events,
  AttachmentBuilder,
} = require('discord.js');

let config = {};
if (fs.existsSync('./config.json')) {
  config = require('./config.json');
}

const token = process.env.TOKEN || config.token;
const guildId = process.env.GUILD_ID || config.guildId;
const ticketCategoryName = config.ticketCategoryName || 'Tickets';
const ticketChannelPrefix = config.ticketChannelPrefix || 'ticket-';
const dataPath = './data.json';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

if (!token) {
  console.error('Discord token is required. Set TOKEN in environment variables or config.json.');
  process.exit(1);
}

function loadData() {
  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify({}, null, 2));
  }
  return JSON.parse(fs.readFileSync(dataPath, 'utf8') || '{}');
}

function saveData(data) {
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

function getGuildData(guildId) {
  const data = loadData();
  if (!data[guildId]) {
    data[guildId] = {};
  }
  return data;
}

function getTranscriptChannelId(guildId) {
  if (process.env.TRANSCRIPT_CHANNEL_ID) {
    return process.env.TRANSCRIPT_CHANNEL_ID;
  }

  const data = loadData();
  return data[guildId] ? data[guildId].transcriptChannelId : undefined;
}

async function getTicketCategory(guild) {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === ticketCategoryName
  );

  if (existing) return existing;

  return guild.channels.create({
    name: ticketCategoryName,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
    ],
  });
}

function buildTicketButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_ticket')
      .setLabel('Open Ticket')
      .setStyle(ButtonStyle.Primary)
  );
}

function makeTicketName(user) {
  const cleanUser = user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = Date.now().toString().slice(-4);
  return `${ticketChannelPrefix}${cleanUser}-${suffix}`;
}

function formatTranscript(messages) {
  return messages
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => {
      const time = new Date(message.createdTimestamp).toISOString();
      const text = message.content || '';
      const attachments = message.attachments.size > 0 ? ` [attachments: ${message.attachments.size}]` : '';
      return `${time} | ${message.author.tag}: ${text}${attachments}`.trim();
    })
    .join('\n');
}

async function buildTranscriptText(channel) {
  const fetchedMessages = await channel.messages.fetch({ limit: 100 });
  return formatTranscript(Array.from(fetchedMessages.values()));
}

function createTranscriptAttachment(channelName, transcriptText) {
  return new AttachmentBuilder(Buffer.from(transcriptText || 'No messages found.', 'utf8'), {
    name: `${channelName}-transcript.txt`,
  });
}

async function deliverTranscript(interaction, currentChannel, transcriptChannel) {
  const transcriptText = await buildTranscriptText(currentChannel);
  const dmAttachment = createTranscriptAttachment(currentChannel.name, transcriptText);

  await interaction.user.send({
    content: `Transcript for ticket **${currentChannel.name}**`,
    files: [dmAttachment],
  }).catch(() => null);

  if (transcriptChannel) {
    const channelAttachment = createTranscriptAttachment(currentChannel.name, transcriptText);
    await transcriptChannel.send({
      content: `Transcript for ticket **${currentChannel.name}**`,
      files: [channelAttachment],
    }).catch(() => null);
  }

  return transcriptText;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (!guildId) {
    console.warn('Guild ID is missing. Set GUILD_ID in environment variables or config.json. Command registration will be skipped.');
    return;
  }

  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set([
    {
      name: 'ticketpanel',
      description: 'Send a simple ticket panel message',
    },
    {
      name: 'close',
      description: 'Close the current ticket channel',
    },
    {
      name: 'settranscript',
      description: 'Set the channel where ticket transcripts are saved',
      options: [
        {
          name: 'channel',
          description: 'Text channel for transcripts',
          type: 7,
          required: true,
        },
      ],
    },
    {
      name: 'transcript',
      description: 'Generate a transcript for this ticket without closing it',
    },
  ]);

  console.log('Slash commands registered for guild', guildId);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName, guild, member } = interaction;

    if (!guild) {
      return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
    }

    const isAdmin = member.permissions.has(PermissionsBitField.Flags.ManageGuild);

    if (commandName === 'ticketpanel') {
      if (!isAdmin) {
        return interaction.reply({ content: 'You do not have permission to create the ticket panel.', ephemeral: true });
      }

      await interaction.reply({
        content: 'Click the button below to open a new ticket.',
        components: [buildTicketButton()],
      });
      return;
    }

    if (commandName === 'settranscript') {
      if (!isAdmin) {
        return interaction.reply({ content: 'You do not have permission to set the transcript channel.', ephemeral: true });
      }

      const channel = interaction.options.getChannel('channel');
      if (!channel || channel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'Please choose a text channel for transcripts.', ephemeral: true });
      }

      if (channel.guildId !== guild.id) {
        return interaction.reply({ content: 'Please select a channel from this server.', ephemeral: true });
      }

      const data = getGuildData(guild.id);
      data[guild.id].transcriptChannelId = channel.id;
      saveData(data);

      await interaction.reply({
        content: `Transcript channel set to ${channel}.`,
        ephemeral: true,
      });
      return;
    }

    if (commandName === 'transcript') {
      const currentChannel = interaction.channel;
      if (!currentChannel || currentChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'This command can only be used in a text channel.', ephemeral: true });
      }

      const category = currentChannel.parent;
      const isTicketChannel = currentChannel.name.startsWith(ticketChannelPrefix) || (category && category.name === ticketCategoryName);
      if (!isTicketChannel) {
        return interaction.reply({ content: 'This command only works inside a ticket channel.', ephemeral: true });
      }

      const transcriptChannelId = getTranscriptChannelId(guild.id);
      if (!transcriptChannelId) {
        return interaction.reply({ content: 'Transcript channel is not set. Use /settranscript first.', ephemeral: true });
      }

      const transcriptChannel = guild.channels.cache.get(transcriptChannelId) || await guild.channels.fetch(transcriptChannelId).catch(() => null);
      if (!transcriptChannel || transcriptChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'Configured transcript channel is invalid or unavailable.', ephemeral: true });
      }

      await deliverTranscript(interaction, currentChannel, transcriptChannel);
      await interaction.reply({ content: `Transcript saved to ${transcriptChannel} and DMed to you.`, ephemeral: true });
      return;
    }

    if (commandName === 'close') {
      const currentChannel = interaction.channel;
      if (!currentChannel || currentChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'This command can only be used in a text channel.', ephemeral: true });
      }

      const category = currentChannel.parent;
      const isTicketChannel = currentChannel.name.startsWith(ticketChannelPrefix) || (category && category.name === ticketCategoryName);
      if (!isTicketChannel) {
        return interaction.reply({ content: 'This command only works inside a ticket channel.', ephemeral: true });
      }

      await interaction.reply({ content: 'Closing this ticket now...', ephemeral: true });

      const transcriptChannelId = getTranscriptChannelId(guild.id);
      const transcriptChannel = transcriptChannelId
        ? guild.channels.cache.get(transcriptChannelId) || await guild.channels.fetch(transcriptChannelId).catch(() => null)
        : null;

      await deliverTranscript(interaction, currentChannel, transcriptChannel && transcriptChannel.type === ChannelType.GuildText ? transcriptChannel : null);
      await currentChannel.delete('Ticket closed');
      return;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId !== 'open_ticket') return;

    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: 'This button must be used in a server.', ephemeral: true });
    }

    const category = await getTicketCategory(guild);
    const ticketName = makeTicketName(interaction.user);

    const ticketChannel = await guild.channels.create({
      name: ticketName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
      ],
      topic: `Ticket opened by ${interaction.user.tag}`,
    });

    await ticketChannel.send(
      `Hello ${interaction.user}, thank you for opening a ticket. Use /close when your issue is resolved.`
    );

    await interaction.reply({
      content: `Your ticket has been opened: ${ticketChannel}`,
      ephemeral: true,
    });
  }
});

client.login(token);

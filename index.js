require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'bumpboard.json');
let db = { user: null, channel: null, leaderboard: {} };

function loadDB() {
    if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
};

function saveDB() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
    loadDB();
    registerCommands();
});

async function registerCommands() {
    const commands = [
        {
            "name": "bump",
            "description": "BumpBoard utilities",
            "options": [
                {
                    "name": "board",
                    "description": "Show the current BumpBoard rankings",
                    "type": 1
                },
                {
                    "name": "setup",
                    "description": "Set up BumpBoard",
                    "type": 1,
                    "options": [
                        {
                            "name": "channel",
                            "description": "Channel to scan",
                            "type": 7,
                            "required": true,
                            "channel_types": [0]
                        },
                        {
                            "name": "user",
                            "description": "Counter bot",
                            "type": 6,
                            "required": true
                        }
                    ]
                }
            ]
        }
    ];
    const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(
            process.env.CLIENT_ID,
            process.env.GUILD_ID,
        ), { body: commands });
        console.log('✅ Slash commands registered');
    } catch (err) {
        console.error('Failed to register commands', err);
    };
};

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if ((interaction.commandName === 'bump') && (interaction.options.getSubcommand() === 'setup')) {
        if (interaction.user.id !== process.env.SETUP_USER_ID) {
            await interaction.reply({ content: '❌ You are not allowed to run this command.', flags: 64 });
            return;
        };
        const channel = interaction.options.getChannel('channel');
        const targetUser = interaction.options.getUser('user');
        await interaction.deferReply({ flags: 64 });
        const MAX_MESSAGES = 1000000;
        const BATCH_SIZE = 100;
        const leaderboard = {};
        let fetchedCount = 0;
        let lastId = null;
        while (fetchedCount < MAX_MESSAGES) {
            console.log(`Fetching messages... (fetched ${fetchedCount})`);
            const options = { limit: BATCH_SIZE };
            if (lastId) options.before = lastId;
            const batch = await channel.messages.fetch(options);
            if (batch.size === 0) break;
            const userMsgs = batch.filter(m => m.author.id === targetUser.id);
            userMsgs.forEach(msg => {
                msg.mentions.users.forEach(mentioned => {
                    const id = mentioned.id;
                    leaderboard[id] = (leaderboard[id] || 0) + 1;
                });
            });
            fetchedCount += batch.size;
            lastId = batch.last().id;
        };
        db = {
            user: targetUser.id,
            channel: channel.id,
            leaderboard
        };
        saveDB();
        await interaction.editReply(
            `✅ Leaderboard initialized for <@${targetUser.id}> in <#${channel.id}>. ` +
            `Scanned ${fetchedCount} recent messages and found ${Object.keys(leaderboard).length} mentioned users.`
        );
    } else if ((interaction.commandName === 'bump') && (interaction.options.getSubcommand() === 'board')) {
        if (!db.leaderboard || (Object.keys(db.leaderboard).length === 0)) {
            await interaction.reply('❌ No leaderboard data found. Run `/setup` first.');
            return;
        };
        await interaction.deferReply({ flags: 64 });
        const activeUsers = await Promise.all(
            Object.entries(db.leaderboard).map(async ([userId, count]) => {
                try {
                    await interaction.guild.members.fetch(userId);
                    return [userId, count];
                } catch {
                    return null;
                };
            }),
        );
        const sorted = activeUsers
            .filter(Boolean)
            .sort((a, b) => b[1] - a[1])
            .slice(0, process.env.TOP ? parseInt(process.env.TOP) : 10);
        if (sorted.length === 0) {
            await interaction.editReply('❌ No leaderboard users are currently in this server.');
            return;
        };
        const embed = new EmbedBuilder()
            .setTitle(String(`${process.env.EMOJI || ''} BumpBoard`).trim())
            .setDescription(`Top ${sorted.length} current server member${(sorted.length === 1) ? '' : 's'}:`)
            .setColor(0x5865F2)
            .setTimestamp();
        sorted.forEach(([userId, count], idx) => {
            embed.addFields({
                name: `#${idx + 1}`,
                value: `<@${userId}>: **${count}** bump${count !== 1 ? 's' : ''}`,
                inline: true,
            });
        });
        await interaction.editReply({ embeds: [embed] });
    };
});

client.on('messageCreate', async msg => {
    if (!msg.author || !msg.author.bot || !msg.author.id || !msg.guildId || !msg.mentions || !msg.mentions.users || !msg.mentions.users.length || !process.env.GUILD_ID || !msg.channelId || !db || !db.channel) return;
    if (msg.guildId !== process.env.GUILD_ID) return;
    if (msg.channelId !== db.channel) return;
    if (msg.author.id !== db.user) return;
    Object.keys(msg.mentions.users).forEach(mentioned => {
        db.leaderboard[mentioned] = (db.leaderboard[mentioned] || 0) + 1;
    });
    saveDB();
});

client.login(process.env.BOT_TOKEN);

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'bumpboard.json');
let db = { user: null, channel: null, leaderboard: {} };

function loadDB() {
    if (fs.existsSync(DATA_FILE)) {
        db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (db.leaderboard) for (const [uid, val] of Object.entries(db.leaderboard)) {
            if (typeof val === 'number') db.leaderboard[uid] = { count: val, last: null };
        };
    };
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
        db.leaderboard = {};
        while (fetchedCount < MAX_MESSAGES) {
            console.log(`Fetching messages... (fetched ${fetchedCount})`);
            const options = { limit: BATCH_SIZE };
            if (lastId) options.before = lastId;
            const batch = await channel.messages.fetch(options);
            if (batch.size === 0) break;
            const userMsgs = batch.filter(m => m.author.id === targetUser.id);
            userMsgs.forEach(msg => {
                const bumpTime = (new Date(msg.createdTimestamp)).toISOString();
                msg.mentions.users.forEach(mentioned => {
                    const entry = (leaderboard[mentioned.id] && (typeof leaderboard[mentioned.id] === 'object')) ? leaderboard[mentioned.id] : ((db.leaderboard[mentioned.id] && (typeof db.leaderboard[mentioned.id] !== 'object') && Number.isFinite(db.leaderboard[mentioned.id])) ? { count: db.leaderboard[mentioned.id], first: null, last: null } : { count: 0, first: null, last: null });
                    entry.count += 1;
                    entry.last = entry.last || bumpTime;
                    entry.first = bumpTime;
                    leaderboard[mentioned.id] = entry;
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
            Object.entries(db.leaderboard).map(async ([userId, entry]) => {
                try {
                    await interaction.guild.members.fetch(userId);
                    const count = (typeof entry === 'number') ? entry : entry.count;
                    const first = (typeof entry === 'object') ? entry.first : null;
                    const last = (typeof entry === 'object') ? entry.last : null;
                    return [userId, { count, first, last }];
                } catch {
                    return null;
                };
            })
        );
        const sorted = activeUsers
            .filter(Boolean)
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, process.env.TOP ? parseInt(process.env.TOP) : 10);
        if (sorted.length === 0) {
            await interaction.editReply('❌ No leaderboard users are currently in this server.');
            return;
        };
        const embed = new EmbedBuilder()
            .setTitle(`${process.env.EMOJI || ''} BumpBoard`.trim())
            .setDescription(`Top ${sorted.length} current server member${(sorted.length === 1) ? '' : 's'}:`)
            .setColor(0x5865F2)
            .setTimestamp();
        sorted.forEach(([userId, data], idx) => {
            const { count, first, last } = data;
            const firstDateStr = first ? `<t:${Math.floor(new Date(first).getTime() / 1000)}:f>` : '—';
            const lastDateStr = last ? `<t:${Math.floor(new Date(last).getTime() / 1000)}:f>` : '—';
            embed.addFields({
                name: `#${idx + 1}`,
                value: `<@${userId}> • **${count}** bump${(count !== 1) ? 's' : ''}\nFirst: ${firstDateStr}\nLast: ${lastDateStr}`,
                inline: true,
            });
        });
        await interaction.editReply({ embeds: [embed] });
    };
});

client.on('messageCreate', async msg => {
    if (!msg || !msg.authorId || !msg.guildId || !msg.mentions || !msg.mentions.users || !msg.mentions.users.length || !process.env.GUILD_ID || !msg.channelId || !db || !db.channel) return;
    if (msg.guildId !== process.env.GUILD_ID) return;
    if (msg.channelId !== db.channel) return;
    if (msg.authorId !== db.user) return;
    const now = (new Date(msg.createdTimestamp)).toISOString();
    if (!db.leaderboard) db.leaderboard = {};
    msg.mentions.users.forEach(mentioned => {
        const entry = (db.leaderboard[mentioned.id] && (typeof db.leaderboard[mentioned.id] === 'object')) ? db.leaderboard[mentioned.id] : ((db.leaderboard[mentioned.id] && (typeof db.leaderboard[mentioned.id] !== 'object') && Number.isFinite(db.leaderboard[mentioned.id])) ? { count: db.leaderboard[mentioned.id], first: null, last: null } : { count: 0, first: null, last: null });
        entry.count += 1;
        entry.first = entry.first || now;
        entry.last = now;
        db.leaderboard[mentioned.id] = entry;
    });
    saveDB();
    if (process.env.EMOJI) {
        try {
            await msg.react(process.env.EMOJI);
        } catch (e) {
            console.warn('Failed to add reaction:', e);
        };
    };
});

client.login(process.env.BOT_TOKEN);

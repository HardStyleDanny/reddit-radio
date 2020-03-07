var discord = require("discord.js");
var colors = require("colors");
var moment = require("moment");

var process = require("process");
var fs = require("fs");
var https = require("https");

var cmdsplit = require("./cmdsplit");
var Radio = require("./Radio");
var MongoClient = require("mongodb").MongoClient;

class RedditRadio
{
	constructor(config)
	{
		this.config = config;
		this.readyPromises = [];

		this.client = new discord.Client();
		this.client.on("message", (msg) => { this.onMessage(msg, false); });
		this.client.on("messageUpdate", (oldMsg, newMsg) => { this.onMessageUpdate(oldMsg, newMsg); });
		this.client.on("guildMemberAdd", (member) => { this.onMemberJoin(member); });
		this.readyPromises.push(this.client.login(this.config.discord.token));

		this.modules = [];

		/*
		this.banned_usernames = fs.readFileSync("banned_usernames.txt").toString().split("\n");
		for (var i = 0; i < this.banned_usernames.length; i++) {
			this.banned_usernames[i] = this.banned_usernames[i].trim();
		}
		*/

		if (this.config.database) {
			this.mongoclient = new MongoClient(this.config.database.url, { useUnifiedTopology: true });
			this.readyPromises.push(this.mongoclient.connect());
		}
	}

	loadConfigModules()
	{
		if (!this.config.modules) {
			return;
		}

		for (var name in this.config.modules) {
			var moduleClass = require('./modules/' + name);
			if (!moduleClass) {
				console.error('Unable to find module with name "' + name + '"!');
				continue;
			}

			console.log('Module: "' + name + '"');

			var config = this.config.modules[name];
			var newModule = new moduleClass(config, this.client, this);
			this.modules.push(newModule);
		}
	}

	onReady()
	{
		this.client.guilds.tap(guild => {
			guild.fetchMembers().then(() => {
				console.log('Cached ' + guild.members.size + ' members in ' + guild.name);
			});
		});

		this.client.user.setActivity(this.config.discord.activity);

		this.logChannel = this.client.channels.get(this.config.discord.logchannel);
		//this.addLogMessage("Bot started!");

		if (this.mongoclient) {
			this.mongodb = this.mongoclient.db(this.config.database.db);
			console.log("Database connected.");
		}

		console.log("Client ready, loading modules...");

		this.loadConfigModules();

		console.log("Modules loaded!");

		setInterval(() => { this.onTick(); }, 1000);
	}

	start()
	{
		Promise.all(this.readyPromises).then(() => {
			this.onReady();
		}).catch((err) => {
			console.error(err);
		});
	}

	stop()
	{
		var promises = [];

		console.log("Stopping client...");
		promises.push(this.client.destroy());

		if (this.mongoclient) {
			console.log("Stopping MongoDB...");
			promises.push(this.mongoclient.close());
		}

		Promise.all(promises).then(() => {
			console.log("Client stopped.");
			process.exit();
		});
	}

	addLogMessage(text, fromMember)
	{
		if (!this.logChannel) {
			console.log("Couldn't log because we couldn't find the log channel:", text);
			return;
		}

		if (fromMember) {
			text += " (via " + fromMember.user.username + ")";
		}

		console.log("Log: " + text);
		this.logChannel.send(":robot: " + text);
	}

	isAdmin(member)
	{
		return member.hasPermission("ADMINISTRATOR");
	}

	isMod(member)
	{
		return member.hasPermission("MANAGE_MESSAGES");
	}

	onTick()
	{
		for (var i = 0; i < this.modules.length; i++) {
			var m = this.modules[i];
			if (m.onTick) {
				m.onTick();
			}
		}
	}

	onMemberJoin(member)
	{
		console.log("User joined: " + member + " (" + member.user.username + ")");
		/*
		var index_normal = this.banned_usernames.indexOf(member.user.username);
		var index_atos = this.banned_usernames.indexOf(member.user.username.replace('a', 's'));
		if (index_normal == -1 && index_atos == -1) {
			return;
		}
		console.warn("Username is in banned usernames list!");
		var millisecondsSinceRegistration = new Date() - member.user.createdAt;
		if (millisecondsSinceRegistration < 30 * 1000) {
			console.log("!! Possible spambot joined: " + member);
			member.kick()
				.then(() => this.addLogMessage("Kicked possible spambot: " + member))
				.catch(console.error);
		} else {
			this.addLogMessage("**Review required**: Possible spambot: " + member);
		}
		*/
	}

	async onMessage(msg, edited)
	{
		// Ignore DM's
		if (msg.member === null && msg.guild === null) {
			console.warn("Ignored a DM: \"" + msg.content + "\"");
			return;
		}

		// Ignore webhooks
		if (msg.webhookID) {
			console.warn("Ignored webhook: \"" + msg.content + "\"");
			return;
		}

		// Ensure we have a member (sometimes this is null if their status is offline)
		if (msg.member === null) {
			console.warn("Member is null, fetching member now");
			msg.member = await msg.guild.fetchMember(msg.author);
		}

		// Ignore our own messages
		if (msg.member.user == this.client.user) {
			return;
		}

		// Log line
		var logUsername = msg.author.username + '#' + msg.author.discriminator;
		if (this.isAdmin(msg.member)) {
			logUsername = logUsername.red;
		} else if (this.isMod(msg.member)) {
			logUsername = logUsername.yellow;
		} else {
			logUsername = logUsername.brightWhite;
		}

		console.log('[' + moment().format('MMM Do LTS') + '] '
			+ logUsername
			+ ' in ' + ('#' + msg.channel.name).green.underline + ': '
			+ (edited ? '(edited) '.gray : '')
			+ '"' + msg.content + '"');

		// Delete unwanted messages only if not a moderator
		if (!this.isMod(msg.member)) {
			// Delete unwanted messages
			if (this.config.filter && (
				(this.config.filter.badwords && msg.content.toLowerCase().match(this.config.filter.badwords)) ||
				(this.config.filter.badtokens && msg.content.match(this.config.filter.badtokens))
				)) {
				this.addLogMessage("Deleted unwanted message from " + msg.author + " in " + msg.channel + ": `" + msg.content.replace('`', '\\`') + "`");
				msg.delete();
				msg.author.send("Your recent message has been automatically deleted. Please take another look at the rules in #info. We automatically delete messages for things like piracy and advertising.");
				return;
			}

			// Delete invite links
			var inviteLinks = msg.content.toLowerCase().match(/discord\.gg\/([A-Za-z0-9]+)/g);
			if (inviteLinks) {
				for (var i = 0; i < inviteLinks.length; i++) {
					//TODO: Put whitelist in config file
					if (inviteLinks[i].toLowerCase() != "discord.gg/hardstyle") {
						this.addLogMessage("Deleted Discord invite link from " + msg.author + " in " + msg.channel + ": `" + inviteLinks[i].replace('/', ' slash ') + "`");
						msg.delete();
						msg.author.send("Your recent message has been automatically deleted. Please do not post Discord invite links without prior permission from a moderator or admin.");
						return;
					}
				}
			}
		}

		var emotes = msg.content.toLowerCase().match(/(<a?:[^:]+:[0-9]+>|\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g);
		if (emotes && emotes.length > 14) {
			this.addLogMessage("Deleted message from " + msg.member + " in " + msg.channel + " that contained " + emotes.length + " emotes");
			msg.delete();
			msg.author.send("You posted too many emojis. Calm down a little bit!");
			return;
		}

		for (var i = 0; i < this.modules.length; i++) {
			var m = this.modules[i];
			if (m.onMessage && m.onMessage(msg, edited)) {
				return;
			}
		}

		if (msg.content.toLowerCase() == "good bot") {
			msg.channel.send(msg.member + " Thanks");
			return;
		}

		if (msg.content.toLowerCase() == "bad bot") {
			msg.channel.send(msg.member + " I'm sorry :sob: If I did something wrong, you can report a bug! <https://github.com/codecat/reddit-radio/issues>");
			return;
		}

		if (msg.content.toLowerCase().indexOf("am i the only one") != -1 && msg.member !== null) {
			msg.channel.send(msg.member + " Probably not.");
			return;
		}

		var parse = cmdsplit(msg.content);

		if (parse.indexOf(".shrug") != -1) {
			msg.channel.send("\xaf\\\\\\_<:headykappa:330110432209797123>\\_/\xaf");
			return;
		}

		if (!msg.content.startsWith(".")) {
			return;
		}

		var cmdID = parse[0].slice(1);
		cmdID = cmdID.charAt(0).toUpperCase() + cmdID.slice(1);
		if (!cmdID.match(/^[a-z]+$/i)) {
			return;
		}

		var cmdName = "onCmd" + cmdID;
		var cmdFound = false;

		if (this[cmdName] !== undefined) {
			if (msg.member !== null) {
				console.log("Built-in command from \"" + msg.member.user.username + "\": " + cmdID);
			} else {
				console.log("Built-in command from offline member: " + cmdID);
			}
			this[cmdName].apply(this, [ msg ].concat(parse.slice(1)));
			cmdFound = true;
		}

		for (var i = 0; i < this.modules.length; i++) {
			var m = this.modules[i];
			if (m[cmdName] === undefined) {
				continue;
			}

			if (msg.member !== null) {
				console.log("Module command from \"" + msg.member.user.username + "\": " + cmdID);
			} else {
				console.log("Module command from offline member: " + cmdID);
			}

			m[cmdName].apply(m, [ msg ].concat(parse.slice(1)));
			cmdFound = true;
		}

		if (!cmdFound) {
			console.log("Unknown command: \"" + cmdName + "\"");
		}
	}

	async onMessageUpdate(oldMsg, newMsg)
	{
		if (oldMsg.content != newMsg.content) {
			this.onMessage(newMsg, true);
		}
	}

	onCmdGithub(msg)
	{
		msg.channel.send("My code is on Github! :robot: https://github.com/codecat/reddit-radio");
	}

	/*
	onCmdWeather(msg)
	{
		var url = "https://api.darksky.net/forecast/" + this.config.weather.apikey + "/" + this.config.weather.coords + "?units=auto";
		https.get(url, (res) => {
			var data = "";
			res.setEncoding("utf8");
			res.on("data", function(chunk) { data += chunk; });
			res.on("end", () => {
				try {
					var obj = JSON.parse(data);
					var ret = "**The weather at Defqon.1 is currently:** (powered by darksky.net)\n";
					ret += "*" + obj.currently.summary + "* / **" + obj.currently.temperature + "\u2103 (" + Math.round((obj.currently.temperature * 9/5) + 32) + "\u2109)** / " + Math.round(obj.currently.humidity * 100) + "% humidity\n";
					ret += "UV index " + obj.currently.uvIndex + ", wind speed " + obj.currently.windSpeed + " m/s";
					msg.channel.send(ret);
				} catch (err) {
					msg.channel.send("I failed to get the weather... :sob:");
					console.log(err);
				}
			});
		});
	}
	*/

	onCmdMute(msg)
	{
		if (!this.isMod(msg.member)) {
			return;
		}

		var mutedRole = msg.guild.roles.find(val => val.name == "Chat mute");
		if (!mutedRole) {
			console.error("Couldn't find \"Chat mute\" role!");
			return;
		}

		for (var memberID of msg.mentions.members.keys()) {
			var member = msg.mentions.members.get(memberID);
			member.addRole(mutedRole);

			this.addLogMessage("Muted " + member.user.username, msg.member);
		}

		msg.delete();
	}

	onCmdUnmute(msg)
	{
		if (!this.isMod(msg.member)) {
			return;
		}

		var mutedRole = msg.guild.roles.find(val => val.name == "Chat mute");
		if (!mutedRole) {
			console.error("Couldn't find \"Chat mute\" role!");
			return;
		}

		for (var memberID of msg.mentions.members.keys()) {
			var member = msg.mentions.members.get(memberID);
			member.removeRole(mutedRole);

			this.addLogMessage("Unmuted " + member.user.username, msg.member);
		}

		msg.delete();
	}

	formatMilliseconds(ms)
	{
		var sec = Math.floor(ms / 1000);

		var secs = sec % 60;
		var mins = Math.floor(sec / 60) % 60;
		var hours = Math.floor(sec / 60 / 60) % 60;

		var ret = "";
		if (hours > 0) {
			ret += hours + "h";
		}
		if (mins > 0) {
			ret += mins + "m";
		}
		ret += secs + "s";
		return ret;
	}

	onCmdTime(msg)
	{
		var date = new Date();
		var hours = date.getHours();
		var minutes = date.getMinutes();

		var text = "The local time is: **" + hours + ":" + (minutes >= 10 ? minutes : "0" + minutes) + "**";

		msg.channel.send(text);
	}
}

module.exports = RedditRadio;

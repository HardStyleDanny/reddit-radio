var Song = require("./Song");

class SongQueue
{
	constructor()
	{
		this.list = [];
	}

	add(url, callback)
	{
		new Song(url, (song) => {
			if (!song.valid) {
				callback(false);
				return;
			}
			this.list.push(song);
			callback(song);
		});
	}

	length()
	{
		return this.list.length;
	}

	remove(index)
	{
	}

	find(name)
	{
	}

	next()
	{
		if (this.list.length == 0) {
			return null;
		}
		return this.list.splice(0, 1)[0];
	}
}

module.exports = SongQueue;

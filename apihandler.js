const { Socket } = require('socket.io');
const Room = require('./rooms');

module.exports = class PixSimAPIHandler {
    #socket;
    #decode;
    #currentRoom;
    #ip;
    #username = 'Unknown';
    #lastCreateGame = 0

    constructor(socket, decode, publicKey) {
        if (!(socket instanceof Socket) || typeof decode != 'function' || publicKey == undefined) throw new TypeError('socket must be a socket.io socket and decode and publicKey must be given');
        this.#socket = socket;
        this.#decode = decode;
        this.#socket.once('clientInfo', async (data) => {
            if (typeof data != 'object' || data === null) socket.disconnect();
            if (data.gameType != 'rps' && data.gameType != 'bps') socket.disconnect();
            this.#ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? '127.0.0.1';
            // verify password
            try {
                console.log(await this.#decode(data.password));
            } catch (err) {
                console.error(this.#ip + ' kicked because password decoding failed');
                socket.disconnect();
            }
            this.#username = data.username;
            socket.emit('clientInfoRecieved');
            this.#socket.on('createGame', this.#createGame);
            this.#socket.on('cancelCreateGame', this.#cancelCreateGame);
            this.#socket.on('getPublicRooms', this.#getPublicRooms);
        });
        this.#socket.emit('requestClientInfo', publicKey);
    }

    #createGame() {
        if (performance.now() - this.#lastCreateGame < 1000) {
            this.#socket.disconnect();
            return;
        }
        this.#lastCreateGame = performance.now();
        this.#currentRoom = new Room(this, this.#socket);
        this.#socket.join(this.#currentRoom.id);
    }
    #cancelCreateGame() {
        if (this.#currentRoom) {
            this.#currentRoom.destroy();
        }
    }
    #getPublicRooms(data) {
        const rooms = Room.publicRooms(data.spectating);
        const games = [];
        for (let room of rooms) {
            if (room.type == data.type || data.type == 'all') games.push({
                code: room.id,
                type: room.type,
                hostName: room.hostName,
                open: room.open,
                teamSize: room.teamSize,
                allowsSpectators: room.allowsSpectators
            });
        }
        this.#socket.emit('publicRooms', games);
    }

    get username() {
        return this.#username;
    }

    destroy() {
        if (this.#currentRoom) this.#currentRoom.destroy();
    }
}
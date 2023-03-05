const Room = require('./rooms');

module.exports = class PixSimAPIHandler {
    #socket;
    #decode;
    #currentRoom;

    constructor(socket, decode) {
        this.#socket = socket;
        this.#decode = decode;
        this.#socket.on('createGame', () => {
            this.#currentRoom = new Room(socket);
            this.#socket.join(this.#currentRoom.id());
            console.log('create game')
        });
        this.#socket._name = 'Unknown';
        this.#socket.once('signIn', (data) => {
            // sign in
        });
        this.#socket.on('getPublicRooms', () => {
            this.#socket.emit('publicRooms', this.getPublicRooms());
        });
    }

    getPublicRooms(type) {
        const rooms = Room.publicRooms();
        const games = [];
        for (let room of rooms) {
            if (room.type() == type) games.push({
                code: room.id(),
                type: room.type(),
                hostName: room.hostName(),
                allowsSpectators: room.allowsSpectators()
            });
        }
        return games;
    }

    destroy() {
        if (this.#currentRoom) this.#currentRoom.destroy();
    }
}
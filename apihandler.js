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
        });
        this.#socket.on('cancelCreateGame', () => {
            if (this.#currentRoom) {
                this.#currentRoom.destroy();
            }
        })
        this.#socket._name = 'Unknown';
        this.#socket.once('signIn', (data) => {
            // sign in
        });
        this.#socket.on('getPublicRooms', (type) => {
            this.#socket.emit('publicRooms', this.getPublicRooms(type));
        });
    }

    getPublicRooms(type) {
        const rooms = Room.publicRooms();
        const games = [];
        for (let room of rooms) {
            if (room.type() == type || type == 'all') games.push({
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
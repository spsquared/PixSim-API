module.exports = class Room {
    static #list = [];
    static #allowedCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    #id;
    #type = 'none';
    #host;
    #opponent;
    #spectators = [];
    #allowSpectators = true;
    #open = true;
    #public = true;
    #addedHostListeners = [];

    constructor(host) {
        this.#id = '';
        for (let i = 0; i < 8; i++) {
            this.#id += Room.#allowedCharacters.charAt(Math.floor(Math.random()*Room.#allowedCharacters.length));
        }
        this.#host = host;
        Room.#list.push(this);
        this.#addHostListener('gameType', (type) => {
            if ((type === 'vaultwars' || type === 'resourcerace') && this.#open) this.#type = type;
        });
        this.#addHostListener('allowSpectators', (bool) => {
            if (typeof bool == 'boolean') this.#allowSpectators = bool;
        });
        this.#addHostListener('isPublic', (bool) => {
            if (typeof bool == 'boolean') this.#public = bool;
        });
        this.#addHostListener('startGame', () => {
            if (this.#opponent !== undefined) {
                this.#host.removeAllListeners('startGame');
                // start game
            }
        });
        this.#host.emit('gameCode', this.#id);
    }

    id() {
        return this.#id;
    }
    type() {
        return this.#type;
    }
    hostSocket() {
        return this.#host;
    }
    opponentSocket() {
        return this.#opponent;
    }
    hostName() {
        return this.#host._name;
    }
    spectatorList() {
        return Arrays.from(this.#spectators);
    }
    allowsSpectators() {
        return this.#allowSpectators;
    }
    isOpen() {
        return this.#open;
    }
    isPublic() {
        return this.#public;
    }

    join(socket) {
        if (this.#open && this.#opponent === undefined) {
            this.#opponent = socket;
            this.#open = false;
        }
    }

    #addHostListener(ev, cb) {
        this.#addedHostListeners.push(ev);
        this.#host.on(ev, cb);
    }
    destroy() {
        for (let ev of this.#addedHostListeners) {
            this.#host.removeAllListeners(ev);
        }
        Room.#list.splice(Room.#list.indexOf(this), 1);
    }

    static publicRooms() {
        const ret = [];
        for (let room of Room.#list) {
            if (room.isOpen() && room.isPublic()) ret.push(room);
        }
        return ret;
    }
}
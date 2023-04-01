module.exports = class Room {
    static #list = [];
    static #allowedCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    #id;
    #type = 'vaultwars';
    #hostHandler;
    #host;
    #teamA = [];
    #teamB = [];
    #teamSize = 1;
    #spectators = [];
    #allowSpectators = true;
    #open = true;
    #public = true;
    #addedHostListeners = [];

    constructor(handler, socket) {
        this.#id = '';
        for (let i = 0; i < 8; i++) {
            this.#id += Room.#allowedCharacters.charAt(Math.floor(Math.random() * Room.#allowedCharacters.length));
        }
        this.#hostHandler = handler;
        this.#host = socket;
        this.#teamA.push(this.#host);
        Room.#list.push(this);
        this.#addHostListener('gameType', (type) => this.gameType = type);
        this.#addHostListener('allowSpectators', (bool) => this.allowSpectators = bool);
        this.#addHostListener('isPublic', (bool) => this.publicGame = bool);
        this.#addHostListener('teamSize', (size) => this.teamSize = size);
        this.#addHostListener('startGame', this.#startGame);
        this.#host.emit('gameCode', this.#id);
    }

    #startGame() {
        if (this.#teamA.length == this.#teamSize && this.#teamB.length == this.#teamSize && !this.#open) {
            // start the game and begin proxy mode
        }
    }

    set gameType(type) {
        if ((type === 'vaultwars' || type === 'resourcerace') && this.#open) this.#type = type;
    }
    set allowSpectators(bool) {
        if (typeof bool == 'boolean' && this.#open) this.#allowSpectators = bool;
    }
    set publicGame(bool) {
        if (typeof bool == 'boolean' && this.#open) this.#public = bool;
    }
    set teamSize(size) {
        if (typeof size == 'number' && size >= 1 && size <= 3 && this.#open) this.#teamSize = size;
    }

    get id() {
        return this.#id;
    }
    get type() {
        return this.#type;
    }
    get hostName() {
        return this.#hostHandler.username;
    }
    get teamSize() {
        return this.#teamSize;
    }
    get allowSpectators() {
        return this.#allowSpectators;
    }
    get isOpen() {
        return this.#open;
    }
    get isPublic() {
        return this.#public;
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

    static publicRooms(spectating) {
        const ret = [];
        for (let room of Room.#list) {
            if ((room.isOpen || spectating) && room.isPublic) ret.push(room);
        }
        return ret;
    }
}
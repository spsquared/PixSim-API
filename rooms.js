class Room {
    static list = [];
    #type = 'none';
    #host = null;
    #opponent = null;
    #spectators = [];
    #allowSpectators = true;
    #open = true;
    #public = true;
    constructor(host) {
        this.#host = host;
        Room.list.push(this);
        host.on()
    }
    type() {
        return this.#type;
    }
    setType(type) {
        if (type != 'vaultwars' && type != 'resourcerace') return;
        this.#type = type;
    }
    hostSocket() {
        return this.#host;
    }
    opponentSocket() {
        return this.#opponent;
    }
    spectatorList() {
        return Arrays.from(this.#spectators);
    }
    isOpen() {
        return this.#open;
    }
    isPublic() {
        return this.#public;
    }
}
const { Socket } = require('socket.io');
const { randomBytes } = require('crypto');
const Logger = require('./log');

/**
 * A handler for a single connection to the PixSim API
 */
class PixSimAPIHandler {
    static #loggerLogsEverything = false;
    static #logger = new Logger('./');

    #socket = null;
    #decode = new Function();
    #currentRoom = null;
    #ip = '';
    #username = 'Unknown';
    #lastCreateGame = 0;
    #externalListeners = new Map();

    constructor(socket, decode, publicKey) {
        if (!(socket instanceof Socket)) {
            throw new TypeError("Socket must be a socket.io socket.");
        }
        else if (typeof decode != "function") {
            throw new TypeError("Decode must be a function!");
        }
        else if (publicKey == null) {
            throw new TypeError("No publickey!!!!");
        }
        // better
        // if (!(socket instanceof Socket) || typeof decode != 'function' || publicKey == undefined) throw new TypeError('socket must be a socket.io socket and decode and publicKey must be given');
        this.#socket = socket;
        this.#decode = decode;
        this.#socket.once('clientInfo', async (data) => {
            if (typeof data != 'object' || data === null) socket.disconnect();
            if (data.gameType != 'rps' && data.gameType != 'bps') socket.disconnect();
            this.#ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? '127.0.0.1';
            this.#username = data.username;
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`Connection: ${this.debugId}`);
            // verify password
            try {
                // console.log(await this.#decode(data.password));
            } catch (err) {
                console.warn(`${this.debugId} kicked because password decoding failed`);
                this.destroy('Invalid encoded password', true);
                return;
            }
            socket.emit('clientInfoRecieved');
            this.#socket.on('createGame', () => this.#createGame());
            this.#socket.on('getPublicRooms', (data) => this.#getPublicRooms(data));
            this.#socket.on('joinGame', (data) => this.#joinGame(data));
            this.#socket.on('leaveGame', () => this.leaveGame());
            this.#socket.on('disconnect', (reason) => {
                if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`Disconnection: ${this.debugId} - ${reason}`)
            });
        });
        this.#socket.emit('requestClientInfo', publicKey);
    }

    #createGame() {
        if (performance.now() - this.#lastCreateGame < 1000) {
            this.destroy('Game creation spam', true);
            return;
        }
        if (this.#currentRoom != null) return;
        this.#lastCreateGame = performance.now();
        this.#currentRoom = new Room(this);
        this.#currentRoom.join(this, false);
        this.#socket.once('cancelCreateGame', () => this.leaveGame());
    }
    #getPublicRooms(data) {
        if (typeof data != 'object') return;
        if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`${this.debugId} requested list of public games`);
        const rooms = Room.publicRooms(data.spectating);
        const games = [];
        for (const room of rooms) {
            if (room.type == data.type || data.type == 'all') games.push({
                code: room.id,
                type: room.type,
                hostName: room.hostName,
                open: room.open,
                teamSize: room.teamSize,
                allowsSpectators: room.allowSpectators
            });
        }
        this.send('publicRooms', games);
    }
    #joinGame(data) {
        if (typeof data != 'object' || this.#currentRoom != null) return;
        if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`${this.debugId} attempted to join game ${data.code}`);
        const rooms = Room.publicRooms(data.spectating);
        for (const room of rooms) {
            if (room.id == data.code) {
                room.join(this, data.spectating);
                this.#currentRoom = room;
                return;
            }
        }
        this.send('joinFail', 0);
    }
    leaveGame() {
        if (this.#currentRoom == null) return;
        this.#currentRoom.leave(this);
        this.#currentRoom = null;
    }

    /**
     * Sends an event with data to the client.
     * @param {string} event Event to send
     * @param {*} data Data to send with the event
     */
    send(event, data) {
        this.#socket.emit(event, data);
    }
    /**
     * Sends an event with data to all clients (except the calling handler) within the current game room
     * @param {string} event Event to send
     * @param {*} data Data to send with the event
     */
    sendToGameRoom(event, data) {
        this.#socket.to(this.#currentRoom.id).emit(event, data);
    }
    /**
     * Adds the socket to a room
     * @param {string} id Room id
     */
    joinGameRoom(id) {
        this.#socket.join(id);
    }
    /**
     * Removes the socket to a room
     * @param {string} id Room id
     */
    leaveGameRoom(id) {
        if (this.#socket.rooms.has(id)) this.#socket.leave(id);
    }
    /**
     * Adds the `callback` function as an event listener for `event`.
     * @param {string} owner ID of the owner of the listener
     * @param {string} event Event to listen for
     * @param {function} callback Listener function run when the event is recieved - can have 1 parameter
     */
    addExternalListener(owner, event, callback) {
        this.#socket.on(event, callback);
        if (!this.#externalListeners.has(owner)) this.#externalListeners.set(owner, new Map());
        if (!this.#externalListeners.get(owner).has(event)) this.#externalListeners.get(owner).set(event, []);
        this.#externalListeners.get(owner).get(event).push(callback);
    }
    /**
     * Removes the `callback` function from the list of event listeners for `event` if the event and
     * listener can be found within the event listeners of the owner.
     * @param {string} owner ID of the owner of the listener
     * @param {string} event Event to listen for
     * @param {function} callback Listener function run when the event is recieved
     */
    removeExternalListener(owner, event, callback) {
        this.#socket.off(event, callback);
        if (!this.#externalListeners.has(owner)) return;
        if (!this.#externalListeners.get(owner).has(event)) return;
        let index = this.#externalListeners.get(owner).get(event).indexOf(callback);
        if (index >= 0) this.#externalListeners.get(owner).get(event).splice(index, 1);
    }
    /**
     * Removes all event listeners in the event listener list of the owner.
     * @param {string} owner ID of the owner of the listener
     */
    removeAllExternalListeners(owner) {
        if (this.#externalListeners.has(owner)) {
            this.#externalListeners.get(owner).forEach((listeners, event) => {
                for (let callback of listeners) {
                    this.#socket.off(event, callback);
                }
            });
            this.#externalListeners.delete(owner);
        }
    }

    /**
     * Username of the player
     */
    get username() {
        return this.#username;
    }
    /**
     * The debug id of the player (username and ip)
     */
    get debugId() {
        return `${this.#username} (${this.#ip})`;
    }

    /**
     * Safely disconnects the handler and leaves the game
     * @param reason Reason the handler was disconnected
     * @param reason Whether the disconnection was forced by a kick
     */
    destroy(reason = 'disconnected', kicked) {
        if (kicked) {
            PixSimAPIHandler.logger.warn(`${this.debugId} kicked - ${reason}`);
        } else {
            PixSimAPIHandler.logger.log(`${this.debugId} disconnected`);
        }
        if (this.#currentRoom) this.#currentRoom.leave(this);
        this.#socket.disconnect();
    }

    static set logEverything(bool) {
        if (typeof bool == 'boolean') this.#loggerLogsEverything = bool;
    }
    /**
     * Whether to log everything that happens
     */
    static get logEverything() {
        return this.#loggerLogsEverything;
    }
    /**
     * The Logger instance used for logging
     */
    static get logger() {
        return this.#logger;
    }
}

/**
 * A single game room coordinating and connecting the host and clients
 */
class Room {
    static #list = new Set();
    #id = '';
    #type = 'pixelcrash';
    #gameModeHandler = null;
    #host = null;
    #teamA = new Set();
    #teamB = new Set();
    #teamSize = 1;
    #spectators = new Set();
    #allowSpectators = true;
    #open = true;
    #public = true;
    #bannedPlayers = [];

    constructor(handler) {
        if (!(handler instanceof PixSimAPIHandler)) throw new Error('handler must be a PixSimAPIHandler');
        this.#id = randomBytes(4).toString('hex').toUpperCase();
        PixSimAPIHandler.logger.log(`${handler.debugId} created game ${this.#id}`);
        this.#host = handler;
        Room.#list.add(this);
        this.#host.joinGameRoom(this.#id);
        this.#host.addExternalListener(this.#id, 'changeTeam', (team) => this.changeTeam(this.#host, team));
        this.#host.addExternalListener(this.#id, 'gameType', (type) => this.gameType = type);
        this.#host.addExternalListener(this.#id, 'allowSpectators', (bool) => this.allowSpectators = bool);
        this.#host.addExternalListener(this.#id, 'isPublic', (bool) => this.publicGame = bool);
        this.#host.addExternalListener(this.#id, 'teamSize', (size) => this.teamSize = size);
        this.#host.addExternalListener(this.#id, 'kickPlayer', (username) => this.kick(username));
        this.#host.addExternalListener(this.#id, 'movePlayer', (data) => this.move(data.username, data.team));
        this.#host.addExternalListener(this.#id, 'startGame', () => this.#start());
        this.#host.send('gameCode', this.#id);
    }

    /**
     * Adds a PixSimAPIHandler to the room. The handler is placed in the spectator list if `spectating`
     * is true. Otherwise it will place it in the team with the lower player count. If both teams are
     * full the handler will be placed as a spectator regardless of `spectating`.
     * @param {PixSimAPIHandler} handler PixSimAPIHandler to add to the room
     * @param {boolean} spectating Whether to join as a spectator or not
     */
    join(handler, spectating = false) {
        if (!(handler instanceof PixSimAPIHandler) || typeof spectating != 'boolean' || !this.#open) return;
        if (spectating || (this.#teamA.size >= this.#teamSize && this.#teamB.size >= this.#teamSize)) {
            PixSimAPIHandler.logger.log(`${handler.debugId} joined game ${this.#id} as a spectator`);
            this.#spectators.add(handler);
            if (!spectating) handler.send('forcedSpectator');
            handler.joinGameRoom(this.#id);
            handler.send('joinSuccess', 0);
            handler.send('gameType', this.#type);
            this.#updateTeamLists();
        } else if (this.#bannedPlayers.indexOf(handler.username) == -1) {
            if (this.#teamB.size < this.#teamA.size) {
                PixSimAPIHandler.logger.log(`${handler.debugId} joined game ${this.#id} on team Beta`);
                this.#teamB.add(handler);
                handler.send('joinSuccess', 2);
            } else {
                PixSimAPIHandler.logger.log(`${handler.debugId} joined game ${this.#id} on team Alpha`);
                this.#teamA.add(handler);
                handler.send('joinSuccess', 1);
            }
            handler.joinGameRoom(this.#id);
            handler.send('gameType', this.#type);
            this.#updateTeamLists();
        }
    }
    /**
     * Moves a PixSimAPIHandler to a different team within the room. If the handler is not within the game
     * or the team it moves to is full then the change is not made.
     * @param {PixSimAPIHandler} handler PixSimAPIHandler to move
     * @param {number} team Team to move to (0 is spectator, 1 is team A, 2 is team B)
     */
    changeTeam(handler, team) {
        if (!(handler instanceof PixSimAPIHandler) || typeof team != 'number' || team < 0 || team > 2 || !this.#open) return;
        switch (team) {
            case 0:
                break;
            case 1:
                if (this.#teamA.size >= this.#teamSize) return;
                break;
            case 2:
                if (this.#teamB.size >= this.#teamSize) return;
                break;
        }
        if (this.#spectators.has(handler)) this.#spectators.delete(handler);
        else if (this.#teamA.has(handler)) this.#teamA.delete(handler);
        else if (this.#teamB.has(handler)) this.#teamB.delete(handler);
        else return;
        PixSimAPIHandler.logger.log(`${handler.debugId} switched to ${team == 0 ? 'spectators' : team == 1 ? 'team Alpha' : 'team Beta'} in game ${this.#id}`);
        if (team == 0) this.#spectators.add(handler);
        else if (team == 1) this.#teamA.add(handler);
        else this.#teamB.add(handler);
        this.#updateTeamLists();
    }
    /**
     * Removes a PixSimAPIHandler from the room.
     * @param {PixSimAPIHandler} handler Handler to remove from the room
     */
    leave(handler) {
        if (!(handler instanceof PixSimAPIHandler)) return;
        if (this.#spectators.has(handler)) this.#spectators.delete(handler);
        else if (this.#teamA.has(handler)) this.#teamA.delete(handler);
        else if (this.#teamB.has(handler)) this.#teamB.delete(handler);
        else return;
        PixSimAPIHandler.logger.log(`${handler.debugId} left game ${this.#id}`);
        handler.leaveGameRoom(this.#id);
        handler.removeAllExternalListeners(this.#id)
        if (handler == this.#host) this.destroy();
        this.#updateTeamLists();
    }
    /**
     * Moves a player to another team
     */
    move(username, team) {
        if (typeof username != 'string' || typeof team != 'number' || team < 0 || team > 2 || !this.#open) return;
        let handler = (Array.from(this.#spectators).find(handler => handler.username == username)
            ?? Array.from(this.#teamA).find(handler => handler.username == username)
            ?? Array.from(this.#teamB).find(handler => handler.username == username));
        if (handler) {
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`${this.#host.debugId} moved ${handler.debugId}`);
            this.changeTeam(handler, team);
        }
    }
    /**
     * Kicks a player from the room (does not ban them).
     * @param {string} username Username of player to be kicked
     */
    kick(username) {
        if (typeof username != 'string') return;
        let handler = (Array.from(this.#spectators).find(handler => handler.username == username)
            ?? Array.from(this.#teamA).find(handler => handler.username == username)
            ?? Array.from(this.#teamB).find(handler => handler.username == username));
        if (handler) {
            PixSimAPIHandler.logger.log(`${this.#host.debugId} kicked ${handler.debugId} from game ${this.#id}`);
            handler.send('gameKicked');
            handler.leaveGame();
        }
    }
    /**
     * Sends a list of all the players in both teams and the spectator list
     */
    #updateTeamLists() {
        const teams = {
            teamA: Array.from(this.#teamA).map(handler => handler.username),
            teamB: Array.from(this.#teamB).map(handler => handler.username),
            spectators: Array.from(this.#spectators).map(handler => handler.username),
            teamSize: this.#teamSize
        };
        this.#host.send('updateTeamLists', teams);
        this.#host.sendToGameRoom('updateTeamLists', teams);
    }
    /**
     * Starts the game
     */
    #start() {
        if (this.#teamA.size == this.#teamSize && this.#teamB.size == this.#teamSize && this.#open) {
            PixSimAPIHandler.logger.log(`Game ${this.#id} started`);
            this.#open = false;
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`Game ${this.#id} pinging players...`);
            new Promise((resolve, reject) => {
                let responses = 0;
                for (let player of [...this.#teamA, ...this.#teamB]) {
                    let res = () => {
                        responses++;
                        player.removeExternalListener(this.#id, 'pong', res);
                        if (responses == this.#teamSize * 2) resolve();
                    };
                    player.addExternalListener(this.#id, 'pong', res);
                    player.send('ping');
                }
            }).then(() => {
                this.#host.addExternalListener(this.#id, 'tick', (tick) => this.#handleTick(tick));
            });
        }
    }
    #handleTick(tick) {
        if (typeof tick != 'object' || !Buffer.isBuffer(tick.grid) || tick.grid.length % 2 != 0 || typeof tick.origin != 'string') {
            console.warn(`${this.#host.debugId} kicked for sending invalid game tick data`);
            this.#host.destroy('Invalid game tick data', true);
        }
        this.#host.sendToGameRoom('tick', tick);
    }

    set gameType(type) {
        if ((type === 'pixelcrash' || type === 'resourcerace') && this.#open) {
            this.#type = type;
            this.#host.sendToGameRoom('gameType', this.#type);
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`game ${this.#id} set gameType to ${this.#type}`);
        }
    }
    set allowSpectators(bool) {
        if (typeof bool == 'boolean' && this.#open) {
            this.#allowSpectators = bool;
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`game ${this.#id} set allowSpectators to ${this.#allowSpectators}`);
        }
    }
    set publicGame(bool) {
        if (typeof bool == 'boolean' && this.#open) {
            this.#public = bool;
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`game ${this.#id} set publicGame to ${this.#public}`);
        }
    }
    set teamSize(size) {
        if (typeof size == 'number' && size >= 1 && size <= 3 && this.#open) {
            this.#teamSize = parseInt(size);
            this.#updateTeamLists();
            if (PixSimAPIHandler.logEverything) PixSimAPIHandler.logger.log(`game ${this.#id} set teamSize to ${this.#teamSize}`);
        }
    }

    /**
     * The ID, which is also the game code
     */
    get id() {
        return this.#id;
    }
    /**
     * Game mode
     */
    get gameType() {
        return this.#type;
    }
    /**
     * Username of the host
     */
    get hostName() {
        return this.#host.username;
    }
    /**
     * The size of the teams
     */
    get teamSize() {
        return this.#teamSize;
    }
    /**
     * Whether spectators are allowed in this game
     */
    get allowSpectators() {
        return this.#allowSpectators;
    }
    /**
     * Whether players are still allowed to join
     */
    get isOpen() {
        return this.#open;
    }
    /**
     * Whether to be listed on the public game lists
     */
    get isPublic() {
        return this.#public;
    }

    /**
     * Safely stops the game and cleans up.
     */
    destroy() {
        PixSimAPIHandler.logger.log(`game ${this.#id} closed`);
        for (const handler of this.#teamA) {
            handler.send('gameEnd');
            handler.leaveGame();
        }
        for (const handler of this.#teamB) {
            handler.send('gameEnd');
            handler.leaveGame(this.#id);
        }
        for (const handler of this.#spectators) {
            handler.send('gameEnd');
            handler.leaveGame(this.#id);
        }
        Room.#list.delete(this);
    }

    /**
     * Gets a list of all open public games, considering whether spectators are on or not.
     * @param {boolean} spectating Only show rooms with spectators on
     * @returns An array of Rooms
     */
    static publicRooms(spectating) {
        const ret = [];
        for (const room of Room.#list) {
            if ((room.isOpen || spectating) && room.isPublic && (room.allowSpectators || !spectating)) ret.push(room);
        }
        return ret;
    }
}

process.on('uncaughtException', (err) => {
    PixSimAPIHandler.logger.error(err.stack);
    console.error(err)
});
process.on('unhandledRejection', (err) => {
    PixSimAPIHandler.logger.error(err.stack);
    console.error(err)
});
process.on('SIGTERM', () => PixSimAPIHandler.logger.destroy());
process.on('SIGINT', () => PixSimAPIHandler.logger.destroy());
process.on('SIGQUIT', () => PixSimAPIHandler.logger.destroy());
process.on('SIGILL', () => PixSimAPIHandler.logger.destroy());

module.exports.PixSimAPIHandler = PixSimAPIHandler;
module.exports.Room = Room;

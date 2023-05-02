const { Server } = require('http');
const { webcrypto, randomBytes } = require('crypto');
const { Server: SocketIO, Socket } = require('socket.io');
const Logger = require('./log');
const PixSimGridAdapter = require('./adapter');

/**
 * A full API opening on an HTTP server utilizing Socket.IO.
 */
class PixSimAPI {
    #loggerLogsEverything = false;
    #logger = null;
    #keys = null;
    #io = null;
    #gridAdapter = null;

    /**
     * Open a PixSim API.
     * @param {Server} server An HTTP `Server`.
     * @param {string} path Path to open the API onto.
     * @param {string} logPath Directory for logging.
     */
    constructor(server, { path = '/pixsim-api/', logPath = './' } = {}) {
        if (!(server instanceof Server)) throw new TypeError('server must be an HTTP server');
        this.#logger = new Logger(logPath);
        this.#gridAdapter = new PixSimGridAdapter(this.#logger);
        // wait for keys and grid adapter to finish loading, then open the server
        new Promise(async (resolve, reject) => {
            this.#keys = await webcrypto.subtle.generateKey({
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            }, false, ['encrypt', 'decrypt']);
            await this.#gridAdapter.ready;
            resolve();
        }).then(() => {
            this.#io = new SocketIO(server, {
                path: path,
                cors: {
                    origin: '*',
                    methods: ['GET', 'POST']
                },
                pingTimeout: 10000,
                upgradeTimeout: 300000
            });
            // unfortunately, there is a giant monolith of code in the constructor, and all the
            // lasses are in this single file because of circular dependencies, hooray for jank!
            const recentConnections = [];
            const recentConnectionKicks = [];
            this.#io.on('connection', async (socket) => {
                // connection DOS detection
                const ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? socket.request.socket.remoteAddress ?? 'unknown';
                recentConnections[ip] = (recentConnections[ip] ?? 0) + 1;
                if (recentConnections[ip] > 3) {
                    if (!recentConnectionKicks[ip]) {
                        log(ip + ' was kicked for connection spam.');
                        this.logger.warn(`Potential DOS attack from ${ip}!`);
                    }
                    recentConnectionKicks[ip] = true;
                    socket.emit('disconnection: ' + ip);
                    socket.removeAllListeners();
                    socket.onevent = function (packet) { };
                    socket.disconnect();
                    return;
                }
                console.log('connection: ' + ip);
    
                // create handler
                const handler = new PixSimHandler(socket, this);
    
                // manage disconnections
                function handleDisconnect(reason) {
                    console.log('disconnection: ' + ip);
                    handler.destroy(reason);
                    clearInterval(timeoutcheck);
                    clearInterval(packetcheck);
                };
                socket.on('disconnect', handleDisconnect);
                socket.on('timeout', handleDisconnect);
                socket.on('error', handleDisconnect);
    
                // timeout
                let timeout = 0;
                const timeoutcheck = setInterval(() => {
                    timeout++;
                    if (timeout > 300) handleDisconnect();
                }, 1000);
    
                // performance metrics
                socket.on('ping', () => {
                    socket.emit('pong');
                });
    
                // socketio dos protection
                let packetCount = 0;
                const onevent = socket.onevent;
                socket.onevent = (packet) => {
                    if (packet.data[0] == null) {
                        handleDisconnect('invalid packet');
                        return;
                    }
                    onevent.call(socket, packet);
                    timeout = 0;
                    packetCount++;
                };
                const packetcheck = setInterval(() => {
                    packetCount = Math.max(packetCount - 250, 0);
                    if (packetCount > 0) {
                        this.logger.warn(`Potential DOS attack from ${handler.debugId}!`);
                        handleDisconnect('socketio spam');
                    }
                }, 1000);
            });
            setInterval(() => {
                for (let i in recentConnections) recentConnections[i] = Math.max(recentConnections[i] - 1, 0);
                for (let i in recentConnectionKicks) delete recentConnectionKicks[i];
            }, 1000);
        });

        // error logs
        process.on('uncaughtException', (err) => {
            this.#logger.error(err.stack);
            console.error(err);
        });
        process.on('unhandledRejection', (err) => {
            this.#logger.error(err.stack);
            console.error(err);
        });
    }

    /**
     * Decode an RSA encoded message using the private key.
     * @param {Buffer} buf `Buffer` resulting from encoding a message using the RSA-OAEP public key.
     * @returns {string} Decoded message.
     * @throws A `TypeError` when decoding fails.
     */
    async decode(buf) {
        return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: "RSA-OAEP" }, this.#keys.privateKey, buf));
    }
    /**
     * RSA-OAEP public key.
     */
    get publicKey() {
        return webcrypto.subtle.exportKey('jwk', this.#keys.publicKey);
    }

    /**
     * The instance of `PixSimGridAdapter`
     */
    get gridAdapter() {
        return this.#gridAdapter;
    }

    set logEverything(bool) {
        if (typeof bool == 'boolean') this.#loggerLogsEverything = bool;
    }
    /**
     * Whether to log everything that happens.
     */
    get logEverything() {
        return this.#loggerLogsEverything;
    }
    /**
     * The `Logger` instance used for logging.
     */
    get logger() {
        return this.#logger;
    }

    /**
     * Disconnects the API
     */
    close() {
        PixSimHandler.destroyAll();
        this.#io.close();
        this.#logger.destroy();
    }
}

/**
 * A handler for a single connection to the PixSim API.
 */
class PixSimHandler {
    static #list = new Set();

    #socket = null;
    #api = null;
    #currentRoom = null;
    #ip = '';
    #username = 'Unknown';
    #clientType = '';
    #lastCreateGame = 0;
    #externalListeners = new Map();

    /**
     * Create a PixSimHandler from a Socket.IO `Socket` and parent `PixSimAPI`.
     * @param {Socket} socket Socket.IO `Socket` to use as connection.
     * @param {PixSimAPI} api Parent `PixSimAPI` instance.
     */
    constructor(socket, api) {
        if (!(socket instanceof Socket)) throw new TypeError('socket must be a socket.io socket');
        if (!(api instanceof PixSimAPI)) throw new TypeError('apiHost must be an instance of PixSimAPI');
        this.#socket = socket;
        this.#api = api;
        this.#socket.once('clientInfo', async (data) => {
            if (typeof data != 'object' || data === null) this.destroy('Invalid connection handshake data');
            if (data.client != 'rps' && data.client != 'bps') this.destroy('Invalid connection handshake data');
            this.#ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? '127.0.0.1';
            this.#username = data.username;
            this.#clientType = data.client;
            if (this.#api.logEverything) this.#api.logger.log(`Connection: ${this.debugId}`);
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
                if (this.#api.logEverything) this.#api.logger.log(`Disconnection: ${this.debugId} - ${reason}`)
            });
        });
        setImmediate(async () => this.#socket.emit('requestClientInfo', await this.#api.publicKey));
        PixSimHandler.#list.add(this);
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
        if (this.#api.logEverything) this.#api.logger.log(`${this.debugId} requested list of public games`);
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
        if (this.#api.logEverything) this.#api.logger.log(`${this.debugId} attempted to join game ${data.code}`);
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
     * @param {string} event Event to send.
     * @param {*} data Data to send with the event.
     */
    send(event, data) {
        this.#socket.emit(event, data);
    }
    /**
     * Sends an event with data to all clients (except the calling handler) within the current game room.
     * @param {string} event Event to send.
     * @param {*} data Data to send with the event.
     */
    sendToGameRoom(event, data) {
        this.#socket.to(this.#currentRoom.id).emit(event, data);
    }
    /**
     * Adds the socket to a room.
     * @param {string} id Room id.
     */
    joinGameRoom(id) {
        this.#socket.join(id);
    }
    /**
     * Removes the socket to a room.
     * @param {string} id Room id.
     */
    leaveGameRoom(id) {
        if (this.#socket.rooms.has(id)) this.#socket.leave(id);
    }
    /**
     * Adds the `callback` function as an event listener for `event`.
     * @param {string} owner ID of the owner of the listener.
     * @param {string} event Event to listen for.
     * @param {function} callback Listener function run when the event is recieved - can have 1 parameter.
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
     * @param {string} owner ID of the owner of the listener.
     * @param {string} event Event to listen for.
     * @param {function} callback Listener function run when the event is recieved.
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
     * @param {string} owner ID of the owner of the listener.
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
     * Username of the player.
     */
    get username() {
        return this.#username;
    }
    /**
     * The game client of the player (currently, only "rps" and "bps" are accepted).
     */
    get clientType() {
        return this.#clientType;
    }
    /**
     * The debug id of the player (username and ip).
     */
    get debugId() {
        return `${this.#username} (${this.#ip})`;
    }

    /**
     * The parent `PixSimAPI` instance.
     */
    get api() {
        return this.#api;
    }
    /**
     * Whether to log everything that happens.
     */
    get logEverything() {
        return this.#api.logEverything;
    }
    /**
     * The `Logger` instance used for logging.
     */
    get logger() {
        return this.#api.logger;
    }

    /**
     * Safely disconnects the handler and leaves the game it is in, if the handler is in one.
     * @param reason Reason the handler was disconnected.
     * @param reason Whether the disconnection was forced by a kick.
     */
    destroy(reason = 'disconnected', kicked) {
        if (kicked) {
            this.#api.logger.warn(`${this.debugId} kicked - ${reason}`);
        } else {
            this.#api.logger.log(`${this.debugId} disconnected`);
        }
        if (this.#currentRoom) this.#currentRoom.leave(this);
        this.#socket.disconnect();
        PixSimHandler.#list.delete(this);
    }
    /**
     * Safely disconects all handlers.
     */
    static destroyAll() {
        PixSimHandler.#list.forEach(h => h.destroy());
    }
}

/**
 * A single game room coordinating and connecting the host and clients.
 */
class Room {
    static #list = new Set();
    #api;
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

    /**
     * Create a `Room` from a `PixSimHandler` host.
     * @param {PixSimHandler} handler `PixSimHandler` instance to use as game host.
     */
    constructor(handler) {
        if (!(handler instanceof PixSimHandler)) throw new TypeError('handler must be a PixSimHandler');
        this.#host = handler;
        this.#api = this.#host.api;
        this.#id = randomBytes(4).toString('hex').toUpperCase();
        this.#host.logger.log(`${handler.debugId} created game ${this.#id}`);
        Room.#list.add(this);
        this.#host.joinGameRoom(this.#id);
        this.#host.addExternalListener(this.#id, 'changeTeam', (team) => this.changeTeam(this.#host, team));
        this.#host.addExternalListener(this.#id, 'gameType', (type) => this.gameType = type);
        this.#host.addExternalListener(this.#id, 'allowSpectators', (bool) => this.allowSpectators = bool);
        this.#host.addExternalListener(this.#id, 'isPublic', (bool) => this.publicGame = bool);
        this.#host.addExternalListener(this.#id, 'teamSize', (size) => this.teamSize = size);
        this.#host.addExternalListener(this.#id, 'kickPlayer', (username) => this.kick(username));
        this.#host.addExternalListener(this.#id, 'movePlayer', (data) => this.move(data.username, data.team));
        this.#host.addExternalListener(this.#id, 'startGame', () => this.start());
        this.#host.send('gameCode', this.#id);
    }

    /**
     * Adds a `PixSimHandler` to the room. The handler is placed in the spectator list if `spectating`
     * is true. Otherwise it will place it in the team with the lower player count. If both teams are
     * full the handler will be placed as a spectator regardless of `spectating`.
     * @param {PixSimHandler} handler `PixSimHandler` to add to the room.
     * @param {boolean} spectating Whether to join as a spectator or not.
     */
    join(handler, spectating = false) {
        if (!(handler instanceof PixSimHandler) || typeof spectating != 'boolean' || !this.#open) return;
        if (spectating || (this.#teamA.size >= this.#teamSize && this.#teamB.size >= this.#teamSize)) {
            this.#host.logger.log(`${handler.debugId} joined game ${this.#id} as a spectator`);
            this.#spectators.add(handler);
            if (!spectating) handler.send('forcedSpectator');
            handler.joinGameRoom(this.#id);
            handler.send('joinSuccess', 0);
            handler.send('gameType', this.#type);
            this.#updateTeamLists();
        } else if (this.#bannedPlayers.indexOf(handler.username) == -1) {
            if (this.#teamB.size < this.#teamA.size) {
                this.#host.logger.log(`${handler.debugId} joined game ${this.#id} on team Beta`);
                this.#teamB.add(handler);
                handler.send('joinSuccess', 2);
            } else {
                this.#host.logger.log(`${handler.debugId} joined game ${this.#id} on team Alpha`);
                this.#teamA.add(handler);
                handler.send('joinSuccess', 1);
            }
            handler.joinGameRoom(this.#id);
            handler.send('gameType', this.#type);
            this.#updateTeamLists();
        }
    }
    /**
     * Moves a `PixSimHandler` to a different team within the room. If the handler is not within the game
     * or the team it moves to is full then the change is not made.
     * @param {PixSimHandler} handler `PixSimHandler` to move.
     * @param {number} team Team to move to (0 is spectator, 1 is team A, 2 is team B).
     */
    changeTeam(handler, team) {
        if (!(handler instanceof PixSimHandler) || typeof team != 'number' || team < 0 || team > 2 || !this.#open) return;
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
        this.#host.logger.log(`${handler.debugId} switched to ${team == 0 ? 'spectators' : team == 1 ? 'team Alpha' : 'team Beta'} in game ${this.#id}`);
        if (team == 0) this.#spectators.add(handler);
        else if (team == 1) this.#teamA.add(handler);
        else this.#teamB.add(handler);
        this.#updateTeamLists();
    }
    /**
     * Removes a `PixSimHandler` from the room.
     * @param {PixSimHandler} handler `PixSimHandler` to remove from the room.
     */
    leave(handler) {
        if (!(handler instanceof PixSimHandler)) return;
        if (this.#spectators.has(handler)) this.#spectators.delete(handler);
        else if (this.#teamA.has(handler)) this.#teamA.delete(handler);
        else if (this.#teamB.has(handler)) this.#teamB.delete(handler);
        else return;
        this.#host.logger.log(`${handler.debugId} left game ${this.#id}`);
        handler.leaveGameRoom(this.#id);
        handler.removeAllExternalListeners(this.#id)
        if (handler == this.#host) this.destroy();
        this.#updateTeamLists();
    }
    /**
     * Moves a player to another team.
     */
    move(username, team) {
        if (typeof username != 'string' || typeof team != 'number' || team < 0 || team > 2 || !this.#open) return;
        let handler = (Array.from(this.#spectators).find(handler => handler.username == username)
            ?? Array.from(this.#teamA).find(handler => handler.username == username)
            ?? Array.from(this.#teamB).find(handler => handler.username == username));
        if (handler) {
            if (this.#host.logEverything) this.#host.logger.log(`${this.#host.debugId} moved ${handler.debugId}`);
            this.changeTeam(handler, team);
        }
    }
    /**
     * Kicks a player from the room (does not ban them).
     * @param {string} username Username of player to be kicked.
     */
    kick(username) {
        if (typeof username != 'string') return;
        let handler = (Array.from(this.#spectators).find(handler => handler.username == username)
            ?? Array.from(this.#teamA).find(handler => handler.username == username)
            ?? Array.from(this.#teamB).find(handler => handler.username == username));
        if (handler) {
            this.#host.logger.log(`${this.#host.debugId} kicked ${handler.debugId} from game ${this.#id}`);
            handler.send('gameKicked');
            handler.leaveGame();
        }
    }
    /**
     * Starts the game. This is usually invoked by the handler itself.
     */
    start() {
        if (this.#teamA.size == this.#teamSize && this.#teamB.size == this.#teamSize && this.#open) {
            this.#host.logger.log(`Game ${this.#id} started`);
            this.#open = false;
            if (this.#host.logEverything) this.#host.logger.log(`Game ${this.#id} pinging players...`);
            new Promise((resolve, reject) => {
                let responses = 0;
                for (let player of [...this.#teamA, ...this.#teamB]) {
                    let res = () => {
                        responses++;
                        player.removeExternalListener(this.#id, 'ready', res);
                        if (responses == this.#teamSize * 2) resolve();
                    };
                    player.addExternalListener(this.#id, 'ready', res);
                    player.send('gameStart');
                }
            }).then(() => {
                this.#host.addExternalListener(this.#id, 'tick', (tick) => this.#handleTick(tick));
                this.#host.addExternalListener(this.#id, 'gridSize', (size) => this.#handleGridSize(size));
            });
        }
    }
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
    #handleGridSize(size) {
        if (typeof size != 'object' || typeof size.width != 'number' || typeof size.height != 'number') {
            console.warn(`${this.#host.debugId} kicked for sending invalid grid size`);
            this.#host.destroy('Invalid grid size', true);
        }
        this.#host.sendToGameRoom('gridSize', { width: size.width, height: size.height });
    }
    #handleTick(tick) {
        if (typeof tick != 'object' || !Buffer.isBuffer(tick.grid) || tick.grid.length % 2 != 0 || typeof tick.origin != 'string') {
            console.warn(`${this.#host.debugId} kicked for sending invalid game tick data`);
            this.#host.destroy('Invalid game tick data', true);
        }
        let redGrid = this.#host.clientType == 'rps' ? tick.grid : undefined;
        let blueGrid = this.#host.clientType == 'bps' ? tick.grid : undefined;
        this.#forEachHandler((handler) => {
            if (handler.clientType == 'rps') {
                if (redGrid == undefined) {
                    redGrid = this.#api.gridAdapter
                }
            } else {
            }
        });
    }

    /**
     * Executes a callback function on every `Handler` in the `Room`. Includes both teams and the spectators.
     * @param {function} cb Callback function.
     */
    #forEachHandler(cb) {
        this.#teamA.forEach(cb);
        this.#teamB.forEach(cb);
        this.#spectators.forEach(cb);
    }

    set gameType(type) {
        if ((type === 'pixelcrash' || type === 'resourcerace') && this.#open) {
            this.#type = type;
            this.#host.sendToGameRoom('gameType', this.#type);
            if (this.#host.logEverything) this.#host.logger.log(`game ${this.#id} set gameType to ${this.#type}`);
        }
    }
    set allowSpectators(bool) {
        if (typeof bool == 'boolean' && this.#open) {
            this.#allowSpectators = bool;
            if (this.#host.logEverything) this.#host.logger.log(`game ${this.#id} set allowSpectators to ${this.#allowSpectators}`);
        }
    }
    set publicGame(bool) {
        if (typeof bool == 'boolean' && this.#open) {
            this.#public = bool;
            if (this.#host.logEverything) this.#host.logger.log(`game ${this.#id} set publicGame to ${this.#public}`);
        }
    }
    set teamSize(size) {
        if (typeof size == 'number' && size >= 1 && size <= 3 && this.#open) {
            this.#teamSize = parseInt(size);
            this.#updateTeamLists();
            if (this.#host.logEverything) this.#host.logger.log(`game ${this.#id} set teamSize to ${this.#teamSize}`);
        }
    }

    /**
     * Parent `PixSimAPI` instance;
     */
    get api() {
        return this.#api;
    }
    /**
     * The ID, which is also the game code.
     */
    get id() {
        return this.#id;
    }
    /**
     * Game mode.
     */
    get gameType() {
        return this.#type;
    }
    /**
     * Username of the host.
     */
    get hostName() {
        return this.#host.username;
    }
    /**
     * The size of the teams.
     */
    get teamSize() {
        return this.#teamSize;
    }
    /**
     * Whether spectators are allowed in this game.
     */
    get allowSpectators() {
        return this.#allowSpectators;
    }
    /**
     * Whether players are still allowed to join.
     */
    get isOpen() {
        return this.#open;
    }
    /**
     * Whether to be listed on the public game lists.
     */
    get isPublic() {
        return this.#public;
    }

    /**
     * Safely stops the game and cleans up.
     */
    destroy() {
        this.#host.logger.log(`game ${this.#id} closed`);
        this.#forEachHandler((handler) => {
            handler.send('gameEnd');
            handler.leaveGame();
        });
        Room.#list.delete(this);
    }

    /**
     * Gets a list of all open public games, considering whether spectators are on or not.
     * @param {boolean} spectating Only show rooms with spectators on.
     * @returns An array of `Room`s.
     */
    static publicRooms(spectating) {
        const ret = [];
        for (const room of Room.#list) {
            if ((room.isOpen || spectating) && room.isPublic && (room.allowSpectators || !spectating)) ret.push(room);
        }
        return ret;
    }
}

module.exports.PixSimAPI = PixSimAPI;
module.exports.PixSimHandler = PixSimHandler;
module.exports.Room = Room;
const { Server } = require('http');
const { webcrypto, randomBytes } = require('crypto');
const { Server: SocketIO, Socket } = require('socket.io');
const Logger = require('../log');
const PixelConverter = require('./converter');
const MapManager = require('./maps');
const ControllerManager = require('./controllers');

/**
 * A full API opening on an HTTP server utilizing Socket.IO.
 */
class PixSimAPI {
    #loggerLogsEverything = false;
    #logger = null;
    #keys = null;
    #io = null;
    #pixelConverter = null;
    #mapManager = null;
    #controllerManager = null;
    #active = false;
    #crashed = false;
    #starting = true;

    /**
     * Open a PixSim API.
     * @param {Express} app An Express app.
     * @param {Server} server An HTTP `Server`.
     * @param {{path: string, logPath: string, logEverything: boolean}} options Additional options.
     * @param {string} options.path Path to open the API onto.
     * @param {string} options.logPath Directory for logging.
     * @param {boolean} options.logEverything To log or not to log everything.
     * @param {boolean} options.allowCache Whether JSLoader is allowed to use the file cache or not.
     */
    constructor(app, server, { path = '/pixsim-api/', mapsPath = './src/multiplayer/maps', controllersPath = './src/multiplayer/controllers', logPath = './', logEverything = false, allowCache = true } = {}) {
        if (typeof app != 'function' || app == null || !app.hasOwnProperty('mkcalendar') || typeof app.mkcalendar != 'function') throw new TypeError('"app" must be an Express app'); // no way to check if it's Express app
        if (!(server instanceof Server)) throw new TypeError('"server" must be an HTTP server');
        if (path.endsWith('/') && path.length > 1) path = path.substring(0, path.length - 1);
        this.#logger = new Logger(logPath);
        if (typeof logEverything == 'boolean') this.logEverything = logEverything;
        console.info('Starting PixSim API');
        this.#logger.info('Starting PixSim API');
        if (!allowCache) this.#logger.info('- File caching for JSLoader is OFF');
        if (logEverything) this.#logger.info('- Logging is set to verbose');
        if (this.#loggerLogsEverything) this.#logger.info(`Setting up Express HTTP middleware on '${path}'`);
        app.get(path, (req, res) => { res.writeHead(301, { location: '/pixsim-api/status' }); res.end(); });
        app.get(path + '/status', (req, res) => res.send({ active: this.active, starting: this.#starting, crashed: this.#crashed, time: Date.now() }));
        if (this.#loggerLogsEverything) this.#logger.info('Creating PixelConverter instance');
        this.#pixelConverter = new PixelConverter([
            {
                id: 'rps',
                url: 'https://raw.githubusercontent.com/spsquared/red-pixel-simulator/master/pixels.js',
                fallback: 'https://red.pixelsimulator.repl.co/pixels.js',
                extractor: 'let p = []; for (let i in pixels) p[i] = pixels[i].numId; return p;'
            },
            {
                id: 'bps',
                url: 'https://raw.githubusercontent.com/maitian352/Blue-Pixel-Simulator/master/pixelData.js',
                fallback: 'https://blue.pixelsimulator.repl.co/pixelData.js',
                extractor: 'return pixsimIds;'
            },
            // {
            //     id: 'psp',
            //     url: 'https://pixel-simulator-platformer-1.maitiansha1.repl.co/pixels.js',
            //     extractor: 'let p = []; for (let i in PIXELS) p[PIXELS[i].id] = i; return p;'
            // }
        ], this.#logger, this.#loggerLogsEverything, allowCache);
        this.#pixelConverter.ready.then(() => { if (this.#loggerLogsEverything) this.#logger.info('PixelConverter ready'); });
        if (this.#loggerLogsEverything) this.#logger.info('Creating MapManager instance');
        this.#mapManager = new MapManager(app, path + '/maps/', mapsPath, this.#pixelConverter, this.#logger, this.#loggerLogsEverything);
        this.#mapManager.ready.then(() => { if (this.#loggerLogsEverything) this.#logger.info('MapManager ready'); });
        if (this.#loggerLogsEverything) this.#logger.info('Creating ControllerManager instance');
        this.#controllerManager = new ControllerManager(app, path + '/controllers/', controllersPath, this.#pixelConverter, this.#logger, this.#loggerLogsEverything);
        this.#controllerManager.ready.then(() => { if (this.#loggerLogsEverything) this.#logger.info('ControllerManager ready'); });
        // wait for everything to finish loading, then open the server
        new Promise(async (resolve, reject) => {
            if (this.#loggerLogsEverything) this.#logger.info('Generating RSA-OAEP keys');
            this.#keys = await webcrypto.subtle.generateKey({
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            }, false, ['encrypt', 'decrypt']);
            if (this.#loggerLogsEverything) this.#logger.info('RSA-OAEP keys generated');
            await this.#mapManager.ready;
            await this.#pixelConverter.ready;
            resolve();
        }).then(() => {
            if (this.#crashed) {
                this.#logger.fatal('PixSimAPI initialization failed during startup.');
                return;
            }
            if (this.#loggerLogsEverything) this.#logger.info('Setting up Socket.IO');
            this.#io = new SocketIO(server, {
                path: path + '/game',
                cors: {
                    origin: '*',
                    methods: ['GET', 'POST']
                },
                pingTimeout: 10000,
                upgradeTimeout: 300000
            });
            // unfortunately, there is a giant monolith of code in the constructor, and all the
            // classes are in this single file because of circular dependencies, hooray for jank!
            const recentConnections = [];
            const recentConnectionKicks = [];
            this.#io.on('connection', async (socket) => {
                if (!this.#active) {
                    socket.disconnect();
                    return;
                }
                // connection DOS detection
                const ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? socket.request.socket.remoteAddress ?? socket.client.conn.remoteAddress ?? 'un-ip';
                recentConnections[ip] = (recentConnections[ip] ?? 0) + 1;
                if (recentConnections[ip] > 3) {
                    if (!recentConnectionKicks[ip]) {
                        log(ip + ' was kicked for connection spam.');
                        this.logger.warn(`Potential DOS attack from ${ip}!`);
                    }
                    recentConnectionKicks[ip] = true;
                    console.log('disconnection: ' + ip);
                    socket.removeAllListeners();
                    socket.onevent = function (packet) { };
                    socket.disconnect();
                    return;
                }
                console.log('Connection: ' + ip);

                // create handler
                const handler = new PixSimHandler(socket, this);

                // manage disconnections
                function handleDisconnect(reason) {
                    console.log('Disconnection: ' + ip);
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
                    if (timeout > 300) handleDisconnect('timed out');
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
            this.#active = true;
            this.#starting = false;
            console.info('PixSim API started');
            this.#logger.info('PixSim API started');
        });

        // error logs
        let handleCrash = (err) => {
            this.#logger.fatal(err instanceof Error ? err.stack : err);
            console.error(err);
            this.#crashed = true;
            process.off('uncaughtException', handleCrash);
            process.off('unhandledRejection', handleCrash);
            this.close();
        };
        process.on('uncaughtException', handleCrash);
        process.on('unhandledRejection', handleCrash);
    }

    /**
     * If the API is accepting requests.
     */
    get active() {
        return this.#active;
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
     * The instance of `PixelConverter`
     */
    get pixelConverter() {
        return this.#pixelConverter;
    }

    set logEverything(bool) {
        if (typeof bool == 'boolean') {
            this.#loggerLogsEverything = bool;
            this.#logger.info('PixSimAPI logEverything to ' + this.#loggerLogsEverything);
        }
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
        if (!this.#active && this.#crashed) return;
        this.#active = false;
        PixSimHandler.destroyAll();
        if (this.#io) this.#io.close();
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
        if (!(socket instanceof Socket)) throw new TypeError('"socket" must be a socket.io socket');
        if (!(api instanceof PixSimAPI)) throw new TypeError('"api" must be an instance of PixSimAPI');
        this.#socket = socket;
        this.#api = api;
        this.#socket.once('clientInfo', async (data) => {
            if (typeof data != 'object' || data === null) this.destroy('Invalid connection handshake data - bad data');
            if (data.client !== 'rps' && data.client !== 'bps' && data.client !== 'psp') this.destroy('Invalid connection handshake data - bad client');
            this.#ip = socket.handshake.headers['x-forwarded-for'] ?? socket.handshake.address ?? socket.request.socket.remoteAddress ?? socket.client.conn.remoteAddress ?? 'un-ip';
            this.#username = data.username;
            this.#clientType = data.client;
            this.#api.logger.info(`Connection: ${this.debugId}`);
            // verify password
            try {
                // console.log(await this.#api.decode(data.password));
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
                this.#api.logger.info(`Disconnection: ${this.debugId} - ${reason}`)
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
        if (typeof data != 'object' || data == null) return;
        if (this.#api.logEverything) this.#api.logger.info(`${this.debugId} requested list of public games`);
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
        if (typeof data != 'object' || data == null || this.#currentRoom != null) return;
        if (this.#api.logEverything) this.#api.logger.info(`${this.debugId} attempted to join game ${data.code}`);
        const rooms = Room.openRooms(data.spectating);
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
     * The game client of the player (currently, only "rps", "bps", and "psp" are accepted).
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
            this.#api.logger.info(`Disconnection: ${this.debugId}`);
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
        if (!(handler instanceof PixSimHandler)) throw new TypeError('"handler" must be a PixSimHandler');
        this.#host = handler;
        this.#api = this.#host.api;
        this.#id = randomBytes(4).toString('hex').toUpperCase();
        this.#host.logger.info(`${handler.debugId} created game ${this.#id}`);
        Room.#list.add(this);
        this.#host.joinGameRoom(this.#id);
        this.#host.addExternalListener(this.#id, 'changeTeam', (team) => this.changeTeam(this.#host, team));
        this.#host.addExternalListener(this.#id, 'gameType', (type) => this.gameType = type);
        this.#host.addExternalListener(this.#id, 'allowSpectators', (bool) => this.allowSpectators = bool);
        this.#host.addExternalListener(this.#id, 'isPublic', (bool) => this.publicGame = bool);
        this.#host.addExternalListener(this.#id, 'teamSize', (size) => this.teamSize = size);
        this.#host.addExternalListener(this.#id, 'kickPlayer', (username) => this.kick(username));
        this.#host.addExternalListener(this.#id, 'movePlayer', (data) => this.move(data.username, data.team, data.username2));
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
        if (!(handler instanceof PixSimHandler) || typeof spectating != 'boolean' || (!spectating && !this.#open)) return;
        if (spectating || (this.#teamA.size >= this.#teamSize && this.#teamB.size >= this.#teamSize)) {
            this.#host.logger.info(`${handler.debugId} joined game ${this.#id} as a spectator`);
            this.#spectators.add(handler);
            if (!spectating) handler.send('forcedSpectator');
            handler.joinGameRoom(this.#id);
            handler.send('joinSuccess', 2);
            handler.send('gameType', this.#type);
            this.#updateTeamLists();
            if (!this.#open) handler.send('gameStart');
        } else if (this.#bannedPlayers.indexOf(handler.username) == -1) {
            if (this.#teamB.size < this.#teamA.size) {
                this.#host.logger.info(`${handler.debugId} joined game ${this.#id} on team Beta`);
                this.#teamB.add(handler);
                handler.send('joinSuccess', 1);
            } else {
                this.#host.logger.info(`${handler.debugId} joined game ${this.#id} on team Alpha`);
                this.#teamA.add(handler);
                handler.send('joinSuccess', 0);
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
     * @param {number} team Team to move to (0 is team A, 1 is team B).
     */
    changeTeam(handler, team) {
        if (!(handler instanceof PixSimHandler) || typeof team != 'number' || team < 0 || team > 1 || !this.#open) return;
        if (team) {
            if (this.#teamB.size >= this.#teamSize) return;
        } else {
            if (this.#teamA.size >= this.#teamSize) return;
        }
        if (this.#teamA.has(handler)) this.#teamA.delete(handler);
        else if (this.#teamB.has(handler)) this.#teamB.delete(handler);
        else return;
        this.#host.logger.info(`${handler.debugId} switched to ${team ? 'team Beta' : 'team Alpha'} in game ${this.#id}`);
        if (team) this.#teamB.add(handler);
        else this.#teamA.add(handler);
        handler.send('team', team)
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
        this.#host.logger.info(`${handler.debugId} left game ${this.#id}`);
        handler.leaveGameRoom(this.#id);
        handler.removeAllExternalListeners(this.#id)
        if (handler == this.#host) this.destroy();
        this.#updateTeamLists();
    }
    /**
     * Moves a player to another team. If the player is not found in the teams (e.g. they are a spectator)
     * nothing is done. If the second player is found (`username2`) then they are swapped.
     * @param {string} username Username of player to move.
     * @param {number} team Team to move to.
     * @param {string} username2 Username of second player to swap with. Not necessary.
     */
    move(username, team, username2 = '') {
        if (typeof username != 'string' || (typeof username2 != 'string' && username2 != undefined) || typeof team != 'number' || team < 0 || team > 1 || !this.#open) return;
        let handler = Array.from(this.#teamA).find(handler => handler.username == username) ?? Array.from(this.#teamB).find(handler => handler.username == username);
        let handler2 = Array.from(this.#teamA).find(handler => handler.username == username2) ?? Array.from(this.#teamB).find(handler => handler.username == username2);
        if (handler) {
            if (handler2) {
                if (this.#host.logEverything) this.#host.logger.info(`${this.#host.debugId} swapped ${handler.debugId} with ${handler2.debugId}`);
                let handler1Team = this.#teamB.has(handler);
                let handler2Team = this.#teamB.has(handler2);
                if (handler1Team == handler2Team) {
                    return;
                } else if (handler1Team) {
                    this.#teamB.delete(handler);
                    this.#teamA.delete(handler2);
                    this.#teamA.add(handler);
                    this.#teamB.add(handler2);
                } else if (handler2Team) {
                    this.#teamA.delete(handler);
                    this.#teamB.delete(handler2);
                    this.#teamB.add(handler);
                    this.#teamA.add(handler2);
                } else {
                    this.#host.logger.fatal(`Attempted to swap ${handler.debugId} with ${handler.debugId}, reached impossible case.`);
                    process.abort();
                }
                this.#updateTeamLists();
            } else {
                if (this.#host.logEverything) this.#host.logger.info(`${this.#host.debugId} moved ${handler.debugId}`);
                this.changeTeam(handler, team);
            }
        }
    }
    /**
     * Kicks a player from the room (does not ban them).
     * @param {string} username Username of player to be kicked.
     */
    kick(username) {
        if (typeof username != 'string') return;
        let handler = Array.from(this.#spectators).find(handler => handler.username == username)
            ?? Array.from(this.#teamA).find(handler => handler.username == username)
            ?? Array.from(this.#teamB).find(handler => handler.username == username);
        if (handler) {
            this.#host.logger.info(`${this.#host.debugId} kicked ${handler.debugId} from game ${this.#id}`);
            handler.send('gameKicked');
            handler.leaveGame();
        }
    }
    /**
     * Starts the game. This is usually invoked by the handler itself.
     */
    start() {
        if (this.#teamA.size == this.#teamSize && this.#teamB.size == this.#teamSize && this.#open) {
            this.#host.logger.info(`Game ${this.#id} started`);
            this.#open = false;
            if (this.#host.logEverything) this.#host.logger.info(`Game ${this.#id} pinging players`);
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
                if (this.#host.logEverything) this.#host.logger.info(`Game ${this.#id} connections checked, starting proxy mode`);
                this.#host.addExternalListener(this.#id, 'gridSize', (size) => this.#handleGridSize(size));
                this.#host.addExternalListener(this.#id, 'tick', (tick) => this.#handleTick(tick));
                this.#teamA.forEach((handler) => {
                    handler.addExternalListener(this.#id, 'input', (input) => this.#handleInput(input, handler, 0));
                    handler.addExternalListener(this.#id, 'inputBatch', (inputs) => this.#handleInputBatch(inputs, handler, 0));
                });
                this.#teamB.forEach((handler) => {
                    handler.addExternalListener(this.#id, 'input', (input) => this.#handleInput(input, handler, 1));
                    handler.addExternalListener(this.#id, 'inputBatch', (inputs) => this.#handleInputBatch(inputs, handler, 1));
                });
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
        if (typeof size != 'object' || size == null || typeof size.width != 'number' || typeof size.height != 'number') {
            console.warn(`${this.#host.debugId} kicked for sending invalid grid size`);
            this.#host.destroy('Invalid grid size', true);
            return;
        }
        this.#host.sendToGameRoom('gridSize', { width: size.width, height: size.height });
    }
    #handleTick(tick) {
        if (typeof tick != 'object' || tick == null || !Buffer.isBuffer(tick.grid)
            || !Buffer.isBuffer(tick.teamGrid) || tick.teamGrid.length < 1
            || !(tick.booleanGrids instanceof Array) || tick.booleanGrids.findIndex(g => !Buffer.isBuffer(g)) != -1
            || typeof tick.origin != 'string' || tick.data == null || typeof tick.data != 'object'
            || typeof tick.data.tick != 'number' || !(tick.data.teamPixelAmounts instanceof Array)) {
            console.warn(`${this.#host.debugId} kicked for sending invalid game tick data`);
            this.#host.destroy('Invalid game tick data', true);
            return;
        }
        let conversionCache = new Map();
        conversionCache.set(this.#host.clientType, { grid: tick.grid, pixels: tick.data.teamPixelAmounts });
        this.#forEachHandler((handler) => {
            if (handler == this.#host) return;
            let conversion;
            if (conversionCache.has(handler.clientType)) {
                conversion = conversionCache.get(handler.clientType);
            } else {
                conversion = {
                    grid: this.#api.pixelConverter.convertGrid(tick.grid, this.#host.clientType, handler.clientType),
                    pixels: tick.data.teamPixelAmounts.map(arr => {
                        let mappedArr = [];
                        for (let n in arr) {
                            if (arr[n] !== 0) mappedArr[this.#api.pixelConverter.convertSingle(n, this.#host.clientType, handler.clientType)] = arr[n];
                        }
                        return mappedArr;
                    })
                };
                conversionCache.set(handler.clientType, conversion);
            }
            handler.send('tick', {
                grid: conversion.grid,
                teamGrid: tick.teamGrid,
                booleanGrids: tick.booleanGrids,
                data: {
                    tick: tick.data.tick,
                    teamPixelAmounts: conversion.pixels,
                    pixeliteCounts: tick.data.pixeliteCounts,
                    cameraShake: tick.data.cameraShake ?? 0
                }
            });
        });
    }
    #handleInputBatch(inputs, handler, team) {
        if (!(inputs instanceof Array)) {
            console.warn(`${handler.debugId} kicked for sending invalid game tick data`);
            handler.destroy('Invalid game tick data', true);
            return;
        }
        let forwarded = [];
        for (let input of inputs) {
            forwarded.push(this.#handleInput(input, handler, team, false));
        }
        this.#host.send('inputBatch', forwarded.filter(f => f != undefined));
    }
    #handleInput(input, handler, team, forward = true) {
        if (typeof input != 'object' || input == null || typeof input.type != 'number' || !(input.data instanceof Array)) {
            console.warn(`${handler.debugId} kicked for sending invalid game tick data`);
            handler.destroy('Invalid game tick data', true);
            return;
        }
        switch (input.type) {
            case 0:
                if (input.data.length != 6) {
                    console.warn(`${handler.debugId} kicked for sending invalid game tick data`);
                    handler.destroy('Invalid game tick data', true);
                    return;
                }
                let newdata = input.data;
                if (input.data[5] != -1) newdata[5] = this.#api.pixelConverter.convertSingle(input.data[5], handler.clientType, this.#host.clientType);
                if (forward) {
                    this.#host.send('input', { type: input.type, team: team, data: newdata });
                } else {
                    return { type: input.type, team: team, data: newdata };
                }
                break;
            case 1:
                if (input.data.length % 2 != 1 || input.data.length < 3) {
                    console.warn(`${handler.debugId} kicked for sending invalid game tick data`);
                    handler.destroy('Invalid game tick data', true);
                    return;
                }
                let inputGrid = this.#api.pixelConverter.convertGrid(Buffer.from(input.data.slice(1)), handler.clientType, this.#host.clientType);
                if (forward) {
                    this.#host.send('input', { type: input.type, team: team, data: [input.data[0], ...inputGrid] });
                } else {
                    return { type: input.type, team: team, data: [input.data[0], ...inputGrid] };
                }
                break;
            default:
                console.warn(`${handler.debugId} kicked for sending invalid game tick data`);
                handler.destroy('Invalid game tick data', true);
        }
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
            if (this.#host.logEverything) this.#host.logger.info(`game ${this.#id} set gameType to ${this.#type}`);
        }
    }
    set allowSpectators(bool) {
        if (typeof bool == 'boolean' && this.#open) {
            this.#allowSpectators = bool;
            if (this.#host.logEverything) this.#host.logger.info(`game ${this.#id} set allowSpectators to ${this.#allowSpectators}`);
        }
    }
    set publicGame(bool) {
        if (typeof bool == 'boolean' && this.#open) {
            this.#public = bool;
            if (this.#host.logEverything) this.#host.logger.info(`game ${this.#id} set publicGame to ${this.#public}`);
        }
    }
    set teamSize(size) {
        if (typeof size == 'number' && size >= 1 && size <= 3 && this.#open) {
            this.#teamSize = parseInt(size);
            this.#updateTeamLists();
            if (this.#host.logEverything) this.#host.logger.info(`game ${this.#id} set teamSize to ${this.#teamSize}`);
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
     * Whether the game is actively running.
     */
    get running() {
        return !this.#open;
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
        this.#host.logger.info(`game ${this.#id} closed`);
        this.#forEachHandler((handler) => {
            handler.send('gameEnd');
            handler.leaveGame();
        });
        Room.#list.delete(this);
    }

    /**
     * Gets a list of all open games, regardless of if the room is public or searching as a spectator.
     * @returns An array of `Room`s.
     */
    static openRooms() {
        const ret = [];
        for (const room of Room.#list) {
            if (room.isOpen) ret.push(room);
        }
        return ret;
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
module.exports = PixSimAPI;
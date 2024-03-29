const fs = require("fs");
const Logger = require("../log");
const PixelConverter = require("./converter");
const path = require("path");

/**
 * MapManager handles serving maps from a directory in different formats
 */
class MapManager {
    #ready;
    #pixelConverter;
    #logger;
    #maps = new Map();

    /**
     * Create a new MapManager and load and convert maps in the `filePath` directory.
     * @param {Express} app An Express app.
     * @param {string} httpPath Path to route map serving to.
     * @param {string} filePath Directory to load maps from.
     * @param {PixelConverter} converter `PixelConverter` instance for converting pixel IDs.
     * @param {Logger} logger `Logger` instance for logging.
     * @param {boolean} logEverything To log or not to log everything.
     */
    constructor(app, httpPath, filePath, converter, logger, logEverything) {
        if (typeof app != 'function' || app == null || !app.hasOwnProperty('mkcalendar') || typeof app.mkcalendar != 'function') throw new TypeError('"app" must be an Express app');
        if (httpPath.endsWith('/') && httpPath.length > 1) httpPath = httpPath.substring(0, httpPath.length - 1);
        if (!fs.existsSync(filePath)) throw new Error('"filePath" must be a valid directory');
        filePath = path.resolve(filePath);
        if (!(converter instanceof PixelConverter)) throw new TypeError('"converter" must be an instance of PixelConverter');
        this.#pixelConverter = converter;
        if (logger instanceof Logger) this.#logger = logger;
        app.get(httpPath + '/list/*', (req, res) => {
            let gameMode = req.path.replace(httpPath + '/list/', '').replace('/', '');
            if (gameMode.length == 0) {
                res.sendStatus(400);
                if (logEverything) this.#debug(`Request for list ${gameMode} fail - 400`);
                return;
            }
            let list = this.mapList(gameMode);
            if (list.length > 0) {
                res.setHeader('Content-Type', 'text/json');
                res.send(JSON.stringify(list));
                if (logEverything) this.#debug(`Request for list ${gameMode} success`);
                return;
            }
            res.sendStatus(404);
            if (logEverything) this.#debug(`Request for list ${gameMode} fail - 404`);
        });
        app.get(httpPath + '/*', (req, res) => {
            let format = req.query.format;
            let [gameMode, map] = req.path.replace(httpPath + '/', '').split('/');
            if (format == undefined || gameMode == undefined || gameMode.length == 0) {
                res.sendStatus(400);
                if (logEverything) this.#debug(`Request for ${gameMode}/${map} fail - 400`);
                return;
            }
            if (this.hasMap(gameMode, map)) {
                res.setHeader('Content-Type', 'text/json');
                res.send(JSON.stringify(this.getMap(gameMode, map, format)));
                if (logEverything) this.#debug(`Request for ${gameMode}/${map} success`);
                return;
            }
            if (logEverything) this.#debug(`Request for ${gameMode}/${map} fail - 404`);
            res.sendStatus(404);
        });
        this.#ready = new Promise(async (resolve, reject) => {
            await this.#pixelConverter.ready;
            if (logEverything) this.#info('Detecting maps in ' + filePath);
            const dirList = fs.readdirSync(filePath);
            const mapList = [];
            for (let dir of dirList) {
                if (fs.lstatSync(path.resolve(filePath, dir)).isDirectory()) {
                    mapList.push(...fs.readdirSync(path.resolve(filePath, dir)).filter((map) => {
                        return fs.lstatSync(path.resolve(filePath, dir, map)).isFile() && map.endsWith('.json');
                    }).map((map) => {
                        return path.join(dir, map);
                    }));
                }
            }
            this.#info(`Found ${mapList.length} maps in ${filePath}`);
            if (logEverything) this.#debug(`Maps found:${mapList.reduce((acc, curr) => acc + `\n    ${curr}`, '')}`);
            for (const map of mapList) {
                let start = performance.now();
                if (map.includes(' ')) this.#warn(`"${map}" includes whitespace characters and will be mapped to "${map.replaceAll(' ', '-').replaceAll('.json', '')}"`);
                const raw = fs.readFileSync(path.resolve(filePath, map));
                try {
                    if (logEverything) this.#debug(`Loading "${map}"`);
                    this.#addMap(map.replaceAll(' ', '-').replaceAll('.json', ''), JSON.parse(raw));
                    if (logEverything) this.#debug(`Loaded "${map}" in ${Math.round(performance.now() - start)}ms`);
                } catch (err) {
                    this.#error(`Failed to load "${map}"`);
                    this.#error(err.stack);
                }
            }
            resolve();
        });
    }

    #addMap(name, map) {
        let [gameMode, id] = name.split(/\/|\\/g);
        if (!this.#maps.has(gameMode)) this.#maps.set(gameMode, new Map());
        this.#maps.get(gameMode).set(id, new Map());
        const mapData = {
            width: map.width,
            height: map.height,
            data: [],
            placeableData: [[], []],
            teamData: [],
            scripts: map.scripts
        };
        switch (map.format) {
            case 'rps':
                const tokens = map.data.split(':');
                tokens.pop();
                for (let str of tokens) {
                    let t = str.split('-');
                    mapData.data.push([this.#pixelConverter.convertStr(t[0], 'rps', 'standard'), parseInt(t[1] ?? 1, 16)]);
                }
                for (let i in map.placeableData) {
                    const tokens = map.placeableData[i].split(':');
                    tokens.pop();
                    let curr = 0;
                    for (let s of tokens) {
                        mapData.placeableData[i].push([curr, parseInt(s, 16)]);
                        curr = (curr + 1) % 2;
                    }
                }
                const tokensoneandahalf = map.teamData.split(':');
                tokensoneandahalf.pop();
                for (let str of tokensoneandahalf) {
                    let t = str.split('-');
                    mapData.teamData.push([parseInt(t[0]), parseInt(t[1], 16)]);
                }
                break;
            case 'bps':
                const tokens2 = map.data.split(':');
                const tokens2andahalf = map.rotationData.split(':');
                tokens2.pop();
                tokens2andahalf.pop();
                const grid1 = new Array(mapData.width * mapData.height);
                const grid2 = new Array(mapData.width * mapData.height);
                let i = 0;
                for (let str of tokens2) {
                    let t = str.split('-');
                    let n = parseInt(t[1] ?? 1, 36);
                    for (let j = 0; j < n; j++) {
                        grid1[i++] = t[0];
                    }
                }
                for (let str of tokens2andahalf) {
                    let t = str.split('-');
                    let n = parseInt(t[1] ?? 1, 36);
                    for (let j = 0; j < n; j++) {
                        grid2[i++] = t[0];
                    }
                }
                let len = 0;
                let curr1 = grid1[0];
                let curr2 = grid2[0];
                for (let i = 0; i < grid1.length; i++) {
                    if (grid1[i] != curr1 || curr2 != grid2[i]) {
                        mapData.data.push([this.#pixelConverter.convertStr(curr1 + curr2, 'bps', 'standard'), len]);
                        len = 0;
                        curr1 = grid1[i];
                        curr2 = grid2[i];
                    }
                    len++;
                }
                for (let i in map.placeableData) {
                    const tokens = map.placeableData[i].split(':');
                    tokens.pop();
                    for (let s of tokens) {
                        let s1 = s.split('-');
                        mapData.placeableData[i].push([parseInt(s1[0]), parseInt(s1[1], 36)]);
                    }
                }
                const tokenstwoandthreequarters = map.teamData.split(':');
                tokenstwoandthreequarters.pop();
                for (let str of tokenstwoandthreequarters) {
                    let t = str.split('-');
                    mapData.teamData.push([parseInt(t[0]), parseInt(t[1], 36)]);
                }
                break;
            case 'psp':
                const tokens3 = map.data.split('|');
                tokens3.pop();
                for (let str of tokens3) {
                    let t = str.split('~');
                    // have to get rid of extra pixel data as is not supported officially (oh no!)
                    mapData.data.push([this.#pixelConverter.convertStr(t[0].split('`')[0], 'psp', 'standard'), parseInt(t[1] ?? 1)]);
                }
                // no placeable grid or team grid...
                break;
        }
        let rpsMapData = {
            data: '',
            placeableData: [],
            teamData: []
        };
        let bpsMapData = {
            data: '',
            placeableData: [],
            teamData: []
        };
        let pspMapData = {
            data: '',
            placeableData: [],
            teamData: ''
        };
        for (let pair of mapData.data) {
            rpsMapData.data += `${this.#pixelConverter.convertStr(pair[0], 'standard', 'rps')}-${pair[1].toString(16)}:`;
            bpsMapData.data += `${this.#pixelConverter.convertStr(pair[0], 'standard', 'bps')}-${pair[1].toString(36)}:`;
            pspMapData.data += `${this.#pixelConverter.convertStr(pair[0], 'standard', 'psp')}~${pair[1].toString(36)}|`;
        }
        for (let placeableData of mapData.placeableData) {
            let curr = 0;
            let len = 0;
            let rpsData = '';
            let bpsData = '';
            let pspData = '';
            for (let pair of placeableData) {
                if (pair[0] != curr) {
                    rpsData += len.toString(16) + ':';
                    len = 0;
                    curr = pair[0];
                }
                len += pair[1];
                bpsData += `${pair[0]}-${pair[1].toString(36)}:`;
                pspData += `${pair[0]}~${pair[1].toString(36)}|`;
            }
            rpsMapData.placeableData.push(rpsData);
            bpsMapData.placeableData.push(bpsData);
            pspMapData.placeableData.push(pspData);
        }
        for (let pair of mapData.teamData) {
            rpsMapData.teamData += `${pair[0]}-${pair[1].toString(16)}:`;
            bpsMapData.teamData += `${pair[0]}-${pair[1].toString(36)}:`;
            pspMapData.teamData += `${pair[0]}~${pair[1].toString(36)}|`;
        }
        this.#maps.get(gameMode).get(id).set('rps', { ...mapData, ...rpsMapData });
        this.#maps.get(gameMode).get(id).set('bps', { ...mapData, ...bpsMapData });
        this.#maps.get(gameMode).get(id).set('psp', { ...mapData, ...pspMapData });
    }

    /**
     * Fetch an array of map IDs in a particular game mode.
     * @param {string} gameMode Gamemode ID to fetch list from.
     * @returns {Array<string>} Array of map IDs within that game mode.
     */
    mapList(gameMode) {
        if (this.#maps.has(gameMode)) return Array.from(this.#maps.get(gameMode).keys());
        else return [];
    }
    /**
     * Check if a map with the ID `name` exists within the game mode of ID `gameMode`.
     * @param {string} gameMode ID of the game mode.
     * @param {string} name ID of the map.
     * @returns {boolean} If the map exists in that game mode.
     */
    hasMap(gameMode, name) {
        if (this.#maps.has(gameMode) && this.#maps.get(gameMode).has(name)) return true;
        return false;
    }
    /**
     * Get the map data of the map under the game mode `gameMode` with the ID `name`, in the specified `format`.
     * @param {string} gameMode ID of the game mode.
     * @param {string} name ID of the map.
     * @param {string} format ID of the format the map should be supplied in.
     * @returns {MapData|null} Data for the map in `MapData  format, or `null` if no such map exists.
     */
    getMap(gameMode, name, format) {
        if (!this.hasMap(gameMode, name)) return null;
        return this.#maps.get(gameMode).get(name).get(format) ?? null;
    }

    /**
     * A `Promise` representing when all maps detected have been loaded and converted.
     */
    get ready() {
        return this.#ready;
    }

    #debug(text) {
        console.debug(text);
        if (this.#logger) this.#logger.debug('[MapManager] ' + text);
    }
    #info(text) {
        console.info(text);
        if (this.#logger) this.#logger.info('[MapManager] ' + text);
    }
    #warn(text) {
        console.warn(text);
        if (this.#logger) this.#logger.warn('[MapManager] ' + text);
    }
    #error(text) {
        console.error(text);
        if (this.#logger) this.#logger.error('[MapManager] ' + text);
    }
}
/**
 * Format of standard PixSim API map data.
 * @typedef {{width: number, height: number, data: string, placeableData: Array<string>, teamData: string, scripts: object}} MapData
 * @param width Integer representing the width of the map.
 * @param height Integer representing the height of the map.
 * @param data Encoded grid.
 * @param placeableData Length-2 array of two encoded boolean grids, each representing the placeable grids of their respective teams.
 * @param teamData Encoded team grid.
 * @param scripts Object, where keys of values are their trigger events and values are the paths of scripts.
 */

module.exports.MapManager = MapManager;
module.exports.MapData = this.MapData;
module.exports = MapManager;
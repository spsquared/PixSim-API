const fs = require("fs");
const JSLoader = require("./jsloader");
const Logger = require("../log");

/**
 * Allows for conversion of pixel ids from one game to another.
 */
class PixelConverter {
    #ready;
    #tables = new Map();
    #idTables = new Map();

    /**
     * Create a new `PixelConverter`, loading and parsing the remote files. Not necessary (and inefficient) to do more than once.
     * @param {Logger} logger `Logger` instance.
     * @param {boolean} logEverything To log or not to log everything.
     */
    constructor(logger, logEverything = false) {
        const redpixelLoader = new JSLoader('https://raw.githubusercontent.com/definitely-nobody-is-here/red-pixel-simulator/master/pixels.js', {
            fallback: 'https://red.pixelsimulator.repl.co/index.js',
            logger: logger,
            allowInsecure: true
        });
        const bluepixelLoader = new JSLoader('https://blue-pixel-simulator.maitiansha1.repl.co/pixelSetup.js', {
            fallback: 'https://blue.pixelsimulator.repl.co/pixelSetup.js',
            logger: logger,
            allowInsecure: true
        });
        const platformerLoader = new JSLoader('https://pixel-simulator-platformer-1.maitiansha1.repl.co/pixels.js', {
            // fallback: '',
            logger: logger,
            allowInsecure: true
        });
        this.#ready = new Promise(async (resolve, reject) => {
            const rawLookup = fs.readFileSync(__dirname + '/pixsimpixelslookup.csv', 'utf8');
            const lookupTable = [];
            rawLookup.split('\n').forEach((line, i) => {
                lookupTable[i] = line.split(',');
            });
            let extract = (gid, loader, script) => {
                return new Promise(async (resolve, reject) => {
                    await loader.ready;
                    if (logEverything) {
                        console.info('[PixelConverter] Extracting pixel IDs for ' + gid);
                        logger.info('[PixelConverter] Extracting pixel IDs for ' + gid);
                    }
                    const pixels = await loader.execute(script);
                    const from = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                    const to = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                    const idfrom = new Map();
                    const idto = new Map();
                    for (let id in pixels) {
                        let lookup = lookupTable.find((v) => v[1] == id);
                        if (lookup) {
                            let id2 = parseInt(lookup[0]);
                            from[pixels[id]] = id2;
                            to[id2] = pixels[id];
                            idfrom.set(id, id2);
                            idto.set(id2, id);
                        }
                    }
                    this.#tables.set(gid, {
                        from: from,
                        to: to
                    });
                    this.#idTables.set(gid, {
                        from: idfrom,
                        to: idto
                    });
                    await loader.terminate();
                    resolve();
                });
            };
            // loads sequentially, but probably doesn't make too big of a difference
            await extract('rps', redpixelLoader, 'let p = []; for (let i in pixels) p[i] = pixels[i].numId; return p;');
            await extract('bps', bluepixelLoader, 'return 1;');
            // await extract('psp', platformerLoader, 'let p = []; for (let i in PIXELS) p[PIXELS[i].id] = i; return p;');
            resolve();
        });
    }

    /**
     * Remap a pixel ID as according to the PixSim API specifications.
     * @param {number} n Incoming numerical ID to convert.
     * @param {string} from ID map of incoming.
     * @param {string} to ID map to convert to.
     * @returns {number} Remapped numerical ID, or the input `n` if conversion is not possible.
     */
    convertSingle(n, from, to) {
        if (this.#tables.has(from) && this.#tables.has(to)) {
            return this.#tables.get(to).to[this.#tables.get(from).from[n]];
        } else return n;
    }
    /**
     * Create a copy of and remap the pixel IDs of a compressed grid as according to the PixSim API specifications.
     * @param {Buffer} grid Incoming compressed grid to convert.
     * @param {string} from ID map of incoming.
     * @param {string} to ID map to convert to.
     * @returns {Buffer} A `Buffer` with same length as `grid` where the numericals IDs have been remapped, or the input `grid` `Buffer` if conversion is not possible.
     */
    convertGrid(grid, from, to) {
        if (this.#tables.has(from) && this.#tables.has(to)) {
            const fromTable = this.#tables.get(from).from;
            const toTable = this.#tables.get(to).to;
            const newGrid = Buffer.from(grid);
            let i = 0;
            while (i < grid.length) {
                header = compressed[i++];
                for (let j = 0; j < 8 && i < grid.length; j++) {
                    newGrid[i] = toTable[fromTable[grid[i]]];
                    if (header & 0b10000000 == 0) i++;
                    i++;
                    header <<= 1;
                }
            }
            return newGrid;
        } else return grid;
    }

    /**
     * 
     * @param {string} id Incoming string ID to convert.
     * @param {string} from ID map of incoming ID.
     * @param {string} to ID map to convert to.
     * @returns {string} Remapped string ID, or the input `id` if conversion is not possible.
     */
    convertId(id, from, to) {
        if (this.#idTables.has(from) && this.#idTables.has(to)) {
            return this.#idTables.get(to).to.get(this.#idTables.get(from).from.get(id));
        } else return id;
    }

    /**
     * A `Promise` representing if the files have been loaded and the pixel data been extracted.
     */
    get ready() {
        return this.#ready;
    }
}

module.exports = PixelConverter;
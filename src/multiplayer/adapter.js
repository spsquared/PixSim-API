const fs = require("fs");
const JSLoader = require("./jsloader");
const Logger = require("../log");

/**
 * Allows for conversion of pixel ids from one game to another.
 */
class PixSimGridAdapter {
    #ready;
    #tables = new Map();

    /**
     * Create a new `PixSimGridAdapter`, loading and parsing the remote files. Not necessary (and inefficient) to do more than once.
     * @param {Logger} logger `Logger` instance.
     */
    constructor(logger) {
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
                    const pixels = await loader.execute(script);
                    const from = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                    const to = new Uint8ClampedArray(Buffer.alloc(256, 0xff));
                    for (let id in pixels) {
                        let lookup = lookupTable.find((v) => v[1] == id);
                        if (lookup) {
                            let id2 = parseInt(lookup[0]);
                            from[pixels[id]] = id2;
                            to[id2] = pixels[id];
                        }
                    }
                    this.#tables.set(gid, {
                        from: from,
                        to: to
                    });
                    await loader.terminate();
                    resolve();
                });
            };
            await extract('rps', redpixelLoader, 'let p = []; for (let i in pixels) p[i] = pixels[i].numId; return p;');
            await extract('bps', bluepixelLoader, 'return 1;');
            // await extract('psp', platformerLoader, 'let p = []; for (let i in PIXELS) p[PIXELS[i].id] = i; return p;');
            resolve();
        });
    }

    /**
     * Remap a pixel ID as according to the PixSim API specifications.
     * @param {number} id Incoming Id convert.
     * @param {string} from ID map of incoming grid.
     * @param {string} to ID map to convert grid to.
     * @returns {number} Remapped pixel ID, or the input `id` if conversion is not possible.
     */
    convertSingle(id, from, to) {
        if (this.#tables.has(from) && this.#tables.has(to)) {
            return this.#tables.get(to).to[this.#tables.get(from).from[id]];
        } else return id;
    }
    /**
     * Create a copy of and remap the pixel IDs of a compressed grid as according to the PixSim API specifications.
     * @param {Buffer} grid Incoming compressed grid to convert.
     * @param {string} from ID map of incoming grid.
     * @param {string} to ID map to convert grid to.
     * @returns {Buffer} A `Buffer` with same length as `grid` where the pixel IDs have been remapped, or the input `grid` `Buffer` if conversion is not possible.
     */
    convertGrid(grid, from, to) {
        if (this.#tables.has(from) && this.#tables.has(to)) {
            let fromTable = this.#tables.get(from).from;
            let toTable = this.#tables.get(to).to;
            let newGrid = Buffer.from(grid);
            for (let i = 0; i < grid.length; i += 2) {
                newGrid[i] = toTable[fromTable[grid[i]]];
            }
            return newGrid;
        } else return grid;
    }

    /**
     * A `Promise` representing if the files have been loaded and the pixel data been extracted.
     */
    get ready() {
        return this.#ready;
    }
}

module.exports = PixSimGridAdapter;
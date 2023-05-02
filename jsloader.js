const fs = require('fs');
const HTTPS = require("https");
const { Worker } = require('worker_threads');
const Logger = require('./log');

/**
 * Parses and executes a JavaScript file loaded from the internet in an isolated Worker thread,
 * allowing execution of code and fetching of data from within the new context. Also keeps a cache of
 * previously loaded files that get replaced every day.
 */
class JSLoader {
    #ready = null;
    #loadTime = 0;
    #fromCache = true;
    #worker = null;
    #running = false;
    #logger;

    /**
     * Parse a new JavaScript file from the web.
     * @param {string} url Primary URL to fetch (must start with "https://").
     * @param {({fallback: string, logger: Logger, dir: string, allowCache: boolean})} options Additional options.
     * @param options.fallback secondary URL in case the primary URL fails to fetch.
     * @param options.logger `Logger` instance for logging.
     * @param options.cache Filepath to the cache directory.
     * @param options.allowCache Allow using cached files.
     */
    constructor(url, { fallback: fallbackUrl, logger, cache: cacheDir = './filecache/', allowCache = true } = {}) {
        if (typeof url != 'string') throw new TypeError('url must be a string');
        if (!url.startsWith('https://')) throw new Error('url has to be an HTTPS url');
        if (typeof fallbackUrl != 'string') fallbackUrl = undefined;
        else if (!fallbackUrl.startsWith('https://')) throw new Error('fallbackUrl has to be an HTTPS url');
        if (cacheDir.length == 0 || cacheDir[cacheDir.length - 1] != '/') throw new Error('cacheDir must be a valid directory');
        if (logger instanceof Logger) this.#logger = logger;
        let readyResolve;
        this.#ready = new Promise((resolve, reject) => readyResolve = resolve);
        try {
            let cacheFileName = cacheDir + url.substring(8).replace(/[\\/:*?<>|]/ig, '-');
            let load = (script) => {
                this.#worker = new Worker(`const{parentPort}=require('worker_threads');const window={addEventListener:()=>{},removeEventListener:()=>{},alert:()=>{},prompt:()=>{},confirm:()=>{},location:{replace:()=>{}},open:()=>{},localStorage:{getItem:()=>{return null;},setItem:()=>{},deleteItem:()=>{}}};const document={addEventListener:()=>{},removeEventListener:()=>{},write:()=>{}};const console={log:()=>{},warn:()=>{},error:()=>{},table:()=>{}};let a=true;${script};parentPort.on('message',(v)=>{try{parentPort.postMessage(new Function(v)());}catch(err){parentPort.postMessage(err.message+err.stack);}});setInterval(()=>{},10000);`, { eval: true });
                this.#running = true;
                readyResolve();
            };
            let writeAndLoad = (script) => {
                // wooo jank
                this.#loadTime = Date.now();
                this.#log(`Loading "${url}" from web`);
                const removePadding = ['+', '-', '*', '/', '%', '&', '|', '^', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '===', '!=', '!==', '>=', '<=', '<', '>', '=>'];
                const removeGap = ['(', ')', '{', '}', '[', ']', ',', '.', ':', ';'];
                let compressedScript = script.replaceAll(/\/\/([^\n]*)/ig, '').replaceAll('\n', '').replaceAll('  ', '');
                for (let s of removePadding) compressedScript = compressedScript.replaceAll(` ${s} `, s);
                for (let s of removeGap) compressedScript = compressedScript.replaceAll(` ${s}`, s).replaceAll(`${s} `, s);
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
                fs.writeFile(cacheFileName, this.#loadTime + '\n' + compressedScript, (err) => {
                    if (err) throw err;
                    this.#log(`Wrote "${cacheFileName}"`);
                });
                load(compressedScript);
            };
            let loadFromWeb = () => {
                this.#httpsGet(url, writeAndLoad, (err) => {
                    if (fallbackUrl) {
                        this.#error(err + ' - using fallback URL');
                        this.#httpsGet(fallbackUrl, writeAndLoad);
                    }
                });
            };
            if (allowCache && fs.existsSync(cacheDir)) {
                if (fs.existsSync(cacheFileName)) {
                    fs.readFile(cacheFileName, { encoding: 'utf-8' }, (err, data) => {
                        if (err) {
                            this.error(err);
                            return;
                        }
                        const raw = data.split('\n');
                        if (raw.length != 2) {
                            this.#error('Expected two lines in cache file, got ' + raw.length);
                            this.#log(`Removing "${cacheFileName}" - invalid cache file`);
                            fs.unlinkSync(cacheFileName);
                        } else if (parseInt(raw[0]) != raw[0]) {
                            this.#error('Expected date integer in first line, got "' + raw[0] + '"');
                            this.#log(`Removing "${cacheFileName}" - invalid cache file`);
                            fs.unlinkSync(cacheFileName);
                        } else if (Date.now() - parseInt(raw[0]) >= 86400000) {
                            this.#log(`Removing "${cacheFileName}" - old cache file`);
                            fs.unlinkSync(cacheFileName);
                        } else {
                            this.#loadTime = parseInt(raw[0]);
                            this.#fromCache = true;
                            this.#log(`Loading "${url}" from cache`);
                            load(raw[1]);
                            return;
                        }
                        loadFromWeb();
                    });
                } else loadFromWeb();
            } else loadFromWeb();
        } catch (err) {
            this.#error(err);
        }
    }

    /**
     * Asynchronously GET a resource using HTTPS
     * @param {string} url URL to fetch from
     * @param {Function} onload Callback when resource is loaded
     * @param {Function} onerror Callback when an error occurs during loading
     */
    #httpsGet(url, onload, onerror = (err) => {
        this.#error(err);
    }) {
        if (typeof url != 'string') throw new TypeError('url must be a string');
        if (typeof onload != 'function' || typeof onerror != 'function') throw new TypeError('onload and onerror must be functions');
        HTTPS.get(url, (res) => {
            if (Math.floor(res.statusCode / 100) != 2) {
                res.resume();
                throw new Error(`HTTPS GET request to '${res.headers.location}' failed: ${res.statusCode}`);
            }
            let raw = '';
            res.on('data', (chunk) => raw += chunk);
            res.on('end', () => onload(raw));
        }).on('error', (err) => onerror(err));
    }

    /**
     * Executes the supplied `script` within the isolated Worker thread.
     * @param {string} script Valid JavaScript code.
     * @returns `Promise` for the result of executing `script` within the isolate (includes errors).
     */
    async execute(script) {
        if (!this.#running) return;
        return await new Promise((resolve, reject) => {
            this.#worker.postMessage(script);
            this.#worker.on('message', (result) => {
                resolve(result);
            });
        });
    }
    /**
     * Stops the Worker thread.
     * @returns `Promise` for the exit code, or -1 if the worker is no longer running.
     */
    async terminate() {
        if (!this.#running) return -1;
        return await this.#worker.terminate();
    }

    /**
     * A `Promise` representing when the loader has parsed the file.
     */
    get ready() {
        return this.#ready;
    }
    /**
     * The time at which the file was loaded in milliseconds since midnight on
     * January 1, 1970 UTC. If loaded from cache, the time is the time at which it was loaded from the internet.
     */
    get loadTime() {
        return this.#loadTime;
    }
    /**
     * If this particular instance was loaded from cache.
     */
    get fromCache() {
        return this.#fromCache;
    }

    #log(text) {
        console.log(text)
        if (this.#logger) this.#logger.log(text);
    }
    #warn(text) {
        console.warn(text);
        if (this.#logger) this.#logger.warn(text);
    }
    #error(text) {
        console.error(text);
        if (this.#logger) this.#logger.error(text);
    }
}

module.exports = JSLoader;
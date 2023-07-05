const fs = require('fs');
const HTTP = require('http');
const HTTPS = require("https");
const { Worker } = require('worker_threads');
const queryString = import('query-string');
const Logger = require('../log');
const path = require('path');

/**
 * Parses and executes a JavaScript file loaded from the internet in an isolated Worker thread,
 * allowing execution of code and fetching of data from within the new context. Also keeps a cache of
 * previously loaded files that get replaced every day.
 * @note NOT SECURE!!!
 */
class JSLoader {
    #ready = null;
    #loadTime = 0;
    #fromCache = true;
    #worker = null;
    #running = false;
    #usingFallback = false;
    #logger;

    /**
     * Parse a new JavaScript file from the web.
     * @param {string} url Primary URL to fetch (must start with "https://").
     * @param {{fallback: string, logger: Logger, cache: string, onerror: function, allowCache: boolean, allowInsecure: boolean}} options Additional options.
     * @param options.fallback secondary URL in case the primary URL fails to fetch.
     * @param options.logger `Logger` instance for logging.
     * @param options.cache Filepath to the cache directory.
     * @param options.onerror Handler called when an error is thrown within the context. By default an error is thrown.
     * @param options.allowCache Allow using cached files.
     * @param options.allowInsecure Allow using an insecure HTTP request when the HTTPS request fails. *JSLoader still is not sandboxed even with this option off!*
     */
    constructor(url, { fallback: fallbackUrl, logger, cache: cacheDir = './filecache/', onerror = (err) => { this.#error(err); }, allowCache = true, allowInsecure = false } = {}) {
        if (typeof url != 'string') throw new TypeError('"url" must be a string');
        if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('"url" has to be an HTTP/HTTPS url');
        if (typeof fallbackUrl != 'string') fallbackUrl = undefined;
        else if (!fallbackUrl.startsWith('http://') && !fallbackUrl.startsWith('https://')) throw new Error('"fallbackUrl" has to be an HTTP/HTTPS url');
        if (logger instanceof Logger) this.#logger = logger;
        if (!fs.existsSync(cacheDir)) throw new Error('"cacheDir" must be a valid directory');
        cacheDir = path.resolve(cacheDir);
        if (typeof onerror != 'function') onerror = (err) => { this.#error(err); };
        let loadStart = performance.now();
        let readyResolve;
        this.#ready = new Promise((resolve, reject) => readyResolve = resolve);
        try {
            let loadingUrl = url;
            let cacheFileName = path.resolve(cacheDir, loadingUrl.substring(8).replace(/[\\/:*?<>|]/ig, '-'));
            let usingInsecure = false;
            let parseScript = (script) => {
                this.#worker = new Worker(`const{parentPort}=require('worker_threads');const window={addEventListener:()=>{},removeEventListener:()=>{},alert:()=>{},prompt:()=>{},confirm:()=>{},location:{replace:()=>{}},open:()=>{},localStorage:{getItem:()=>{return null;},setItem:()=>{},deleteItem:()=>{}}};const document={addEventListener:()=>{},removeEventListener:()=>{},write:()=>{},getElementById:()=>{return{style:{}}}};const console={log:()=>{},warn:()=>{},error:()=>{},table:()=>{}};${script};parentPort.on('message',(v)=>{try{parentPort.postMessage(new Function(v)());}catch(err){parentPort.postMessage(err.stack);}});setInterval(()=>{},10000);`, { eval: true, });
                this.#worker.on('error', handleLoadError);
                this.#worker.on('online', () => {
                    let handle = (result) => {
                        this.#worker.off('message', handle);
                        this.#running = true;
                        this.#debug(`Loaded ${loadingUrl} in ${Math.round(performance.now() - loadStart)}ms`);
                        readyResolve();
                    };
                    this.#worker.on('message', handle);
                    this.#worker.postMessage('return 1');
                });
            };
            let writeAndParse = (script) => {
                this.#loadTime = Date.now();
                this.#info(`Loading ${loadingUrl} from web`);
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
                this.minify(script).then((minifiedScript) => {
                    fs.writeFile(cacheFileName, this.#loadTime + '\n' + minifiedScript, (err) => {
                        if (err) this.#error(err.stack);
                        else this.#info(`Wrote "${cacheFileName}"`);
                    });
                    parseScript(minifiedScript);
                }).catch((err) => this.#error(err.stack));
            };
            let load = () => {
                if (allowCache && fs.existsSync(cacheDir)) {
                    if (fs.existsSync(cacheFileName)) {
                        fs.readFile(cacheFileName, { encoding: 'utf-8' }, (err, data) => {
                            if (err) {
                                this.error(err.stack);
                                return;
                            }
                            const raw = data.split('\n');
                            if (raw.length == 0) {
                                this.#warn('Cache file empty');
                                this.#info(`Removing "${cacheFileName}" - empty cache file`);
                                fs.unlinkSync(cacheFileName);
                            if (parseInt(raw[0]) != raw[0]) {
                                this.#warn('Expected date integer in first line, got "' + raw[0] + '"');
                                this.#info(`Removing "${cacheFileName}" - invalid cache file`);
                                fs.unlinkSync(cacheFileName);
                            } else if (Date.now() - parseInt(raw[0]) >= 86400000) {
                                this.#info(`Removing "${cacheFileName}" - old cache file`);
                                fs.unlinkSync(cacheFileName);
                            } else {
                                this.#loadTime = parseInt(raw[0]);
                                this.#fromCache = true;
                                this.#info(`Loading ${loadingUrl} from cache (${cacheFileName})`);
                                parseScript(raw[1]);
                                return;
                            }
                            loadFromWeb();
                        });
                    } else loadFromWeb();
                } else loadFromWeb();
            };
            let loadFromWeb = () => {
                if (usingInsecure) {
                    this.httpGet(loadingUrl.replace('https://', 'http://')).then(writeAndParse).catch(handleLoadError);
                } else {
                    this.httpsGet(loadingUrl.replace('http://', 'https://')).then(writeAndParse).catch(handleLoadError);
                }
            };
            let handleLoadError = (err) => {
                if (!usingInsecure && allowInsecure && ((err instanceof Error && err.message.toLowerCase().includes('ssl')) || (typeof err == 'string' && err.toLowerCase().includes('ssl')))) {
                    if (this.#usingFallback) {
                        this.#warn(err.stack);
                        this.#warn(`SSL Error loading ${fallbackUrl} (${Math.round(performance.now() - loadStart)}ms) - trying again using HTTP`);
                        loadStart = performance.now();
                        usingInsecure = true;
                        load();
                    } else {
                        this.#warn(err.stack);
                        this.#warn(`SSL Error loading ${url} (${Math.round(performance.now() - loadStart)}ms) - trying again using HTTP`);
                        loadStart = performance.now();
                        usingInsecure = true;
                        load();
                    }
                } else {
                    if (fallbackUrl) {
                        if (!this.#usingFallback) {
                            this.#usingFallback = true;
                            cacheFileName = path.resolve(cacheDir, fallbackUrl.substring(8).replace(/[\\/:*?<>|]/ig, '-'));
                            loadingUrl = fallbackUrl;
                            this.#warn(err.stack);
                            this.#warn(`Error loading ${url} (${Math.round(performance.now() - loadStart)}ms) - using fallback source (${fallbackUrl})`);
                            loadStart = performance.now();
                            usingInsecure = false;
                            load();
                        } else {
                            this.#error(err.stack);
                            this.#error(`Error loading ${fallbackUrl} (${Math.round(performance.now() - loadStart)}ms) - main and fallback loads failed, parse failed`);
                            if (onerror) onerror(err);
                        }
                    } else {
                        this.#error(err.stack);
                        this.#error(`Error loading ${url} (${Math.round(performance.now() - loadStart)}ms) - no fallback source provided, parse failed`);
                        if (onerror) onerror(err);
                    }
                }
            };
            load();
        } catch (err) {
            onerror(err);
        }
    }

    /**
     * Asynchronously GET a resource using HTTP (insecure)
     * @param {string} url URL to fetch from
     * @param {Function} onload Callback when resource is loaded
     * @param {Function} onerror Callback when an error occurs during loading
     */
    httpGet(url) {
        if (typeof url != 'string') throw new TypeError('url must be a string');
        return new Promise((resolve, reject) => {
            HTTP.get(url, (res) => {
                if (res.statusCode != 200) {
                    res.resume();
                    reject(new Error(`HTTP GET request to ${res.headers.location} failed: ${res.statusCode}`));
                }
                let raw = '';
                res.on('data', (chunk) => raw += chunk);
                res.on('end', () => resolve(raw));
            }).on('error', (err) => reject(err));
        });
    }
    /**
     * Asynchronously GET a resource using HTTPS
     * @param {string} url URL to fetch from
     * @param {Function} onload Callback when resource is loaded
     * @param {Function} onerror Callback when an error occurs during loading
     */
    httpsGet(url) {
        if (typeof url != 'string') throw new TypeError('url must be a string');
        return new Promise((resolve, reject) => {
            HTTPS.get(url, (res) => {
                if (res.statusCode != 200) {
                    res.resume();
                    reject(new Error(`HTTPS GET request to ${res.headers.location} failed: ${res.statusCode}`));
                }
                let raw = '';
                res.on('data', (chunk) => raw += chunk);
                res.on('end', () => resolve(raw));
            }).on('error', (err) => reject(err));
        });
    }
    /**
     * Asynchronously use the www.toptal.com 's JavaScript minifier API to minify a script.
     * @param {string | function} script JavaScript to minify.
     */
    minify(script) {
        if (typeof script != 'string' && typeof script != 'function') throw new TypeError('script must be a string or function');
        return new Promise(async (resolve, reject) => {
            const query = (await queryString).default.stringify({ input: script.toString() });
            HTTPS.request({
                method: 'POST',
                hostname: 'www.toptal.com',
                path: '/developers/javascript-minifier/api/raw'
            }, (res) => {
                if (res.statusCode != 200) {
                    res.resume();
                    reject(new Error(`HTTPS POST request to ${res.headers.location} failed: ${res.statusCode}`));
                }
                let raw = '';
                res.on('data', (chunk) => raw += chunk);
                res.on('end', () => resolve(raw));
            }).on('error', (err) => reject(err)).setHeader('Content-Type', 'application/x-www-form-urlencoded').end(query, 'utf8');
        });
    }

    /**
     * Executes the supplied `script` within the isolated Worker thread.
     * @param {string} script Valid JavaScript code.
     * @returns `Promise` for the result of executing `script` within the isolate (includes errors).
     */
    async execute(script) {
        return await new Promise((resolve, reject) => {
            if (!this.#running) reject(new Error('Worker is not running'));
            let handle = (result) => {
                this.#worker.off('message', handle);
                resolve(result);
            };
            this.#worker.on('message', handle);
            this.#worker.postMessage(script);
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
     * If the internal Worker is still active and executing code;
     */
    get running() {
        return this.#running;
    }
    /**
     * A `Promise` representing when the loader has parsed the file.
     */
    get ready() {
        return this.#ready;
    }
    /**
     * If the JSLoader had to parse the fallback.
     */
    get fromFallback() {
        return this.#usingFallback;
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

    #debug(text) {
        if (this.#logger) this.#logger.debug('[JSLoader] ' + text);
    }
    #info(text) {
        console.info(text);
        if (this.#logger) this.#logger.info('[JSLoader] ' + text);
    }
    #warn(text) {
        console.warn(text);
        if (this.#logger) this.#logger.warn('[JSLoader] ' + text);
    }
    #error(text) {
        console.error(text);
        if (this.#logger) this.#logger.error('[JSLoader] ' + text);
    }
}

module.exports = JSLoader;
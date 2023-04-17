const fs = require('fs');

class Logger {
    #file;

    constructor(path) {
        if (typeof path != 'string') throw new TypeError('file path must be a string');
        try {
            let filePath = path + 'log.log';
            if (fs.existsSync(filePath)) {
                let dirPath = path + 'log/';
                if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
                let fileCount = fs.readdirSync(dirPath).length;
                fs.renameSync(filePath, dirPath + `log-${fileCount}.log`);
            }
            this.#file = fs.openSync(filePath, 'a');
            console.log('Logger instance created');
        } catch (err) {
            console.error(err);
        }
    }

    currentTimestamp() {
        const time = new Date();
        let month = time.getMonth().toString();
        let day = time.getDate().toString();
        let hour = time.getHours().toString();
        let minute = time.getMinutes().toString();
        if(month.length == 1) month = 0 + month;
        if(day.length == 1) day = 0 + day;
        if(hour.length == 1) hour = 0 + hour;
        if(minute.length == 1) minute = 0 + minute;
        return `${time.getFullYear()}-${month}-${day} [${hour}:${minute}]`;
    }
    log(text) {
        let prefix = `${this.currentTimestamp()}   LOG | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, {encoding: 'utf-8'}, (err) => {if (err) console.error(err)});
    }
    warn(text) {
        let prefix = `${this.currentTimestamp()}  WARN | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, {encoding: 'utf-8'}, (err) => {if (err) console.error(err)});
    }
    error(text) {
        let prefix = `${this.currentTimestamp()} ERROR | `;
        fs.appendFile(this.#file, `${prefix}${text.toString().replaceAll('\n', `\n${prefix}`)}\n`, {encoding: 'utf-8'}, (err) => {if (err) console.error(err)});
    }

    destroy() {
        fs.closeSync(this.#file);
    }
}

module.exports = Logger;
console.info('Starting PixSim API');
const express = require('express');
const app = express();
const server = require('http').Server(app);
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 1000,
  max: 300,
  handler: function(req, res, options) { }
});
app.use(limiter);

const { subtle } = require('crypto').webcrypto;
const keys = subtle.generateKey({
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256"
}, false, ['encrypt', 'decrypt']);

// set io
const recentConnections = [];
const recentConnectionKicks = [];
const io = new (require('socket.io')).Server(server, {
  path: '/pixsim-api/',
  pingTimeout: 10000,
  upgradeTimeout: 300000
});
io.on('connection', function(socket) {
  socket.handshake.headers['x-forwarded-for'] = socket.handshake.headers['x-forwarded-for'] ?? '127.0.0.1';
  recentConnections[socket.handshake.headers['x-forwarded-for']] = (recentConnections[socket.handshake.headers['x-forwarded-for']] ?? 0) + 1;
  if (recentConnections[socket.handshake.headers['x-forwarded-for']] > 3) {
    if (!recentConnectionKicks[socket.handshake.headers['x-forwarded-for']]) log('IP ' + socket.handshake.headers['x-forwarded-for'] + ' was kicked for connection spam.');
    recentConnectionKicks[socket.handshake.headers['x-forwarded-for']] = true;
    socket.emit('disconnected');
    socket.removeAllListeners();
    socket.onevent = function(packet) { };
    socket.disconnect();
    return;
  }
  // public RSA key
  socket.once('requestPublicKey', async function() {
    socket.emit('publicKey', await subtle.exportKey('jwk', (await keys).publicKey));
  });

  // manage disconnections
  const disconnectPings = setInterval(function() {
    socket.emit('ping');
    let timeoutdetect = setTimeout(async function() {
      await player.leave();
      clearInterval(disconnectPings);
    }, 10000);
    socket.once('pong', function() {
      clearTimeout(timeoutdetect);
    });
  }, 1000);
});
setInterval(function() {
  for (let i in recentConnections) {
    recentConnections[i] = Math.max(recentConnections[i] - 1, 0);
  }
  for (let i in recentConnectionKicks) {
    delete recentConnectionKicks[i];
  }
}, 1000);

async function RSAdecodeAPI(buf) {
  return new TextDecoder().decode(await subtle.decrypt({ name: "RSA-OAEP" }, (await keys).privateKey, buf));
};
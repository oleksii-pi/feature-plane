const net = require("node:net");

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function normalizePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) return null;
  return parsed;
}

async function allocateAvailablePort(excludedPorts = new Set()) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await getEphemeralPort();
    if (excludedPorts.has(port)) continue;
    return port;
  }

  throw new Error("Unable to allocate an available application port.");
}

function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Unable to read allocated port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

module.exports = {
  allocateAvailablePort,
  normalizePort,
};

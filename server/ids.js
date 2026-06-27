const { randomUUID } = require("node:crypto");

function shortGuid() {
  return randomUUID().split("-")[0];
}

function createId(prefix) {
  return `${prefix}-${shortGuid()}`;
}

module.exports = {
  createId,
  shortGuid,
};

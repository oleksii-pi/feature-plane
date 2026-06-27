const { randomUUID } = require("node:crypto");

function shortGuid() {
  return randomUUID().split("-")[0];
}

function createId() {
  return shortGuid();
}

module.exports = {
  createId,
  shortGuid,
};

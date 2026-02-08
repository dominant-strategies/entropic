// Stub out clipboard module for Docker container
module.exports = {
  read: () => '',
  write: () => {},
  readSync: () => '',
  writeSync: () => {},
  readImage: () => null,
  writeImage: () => {},
  readImageSync: () => null,
  writeImageSync: () => {},
  clear: () => {},
  clearSync: () => {},
};
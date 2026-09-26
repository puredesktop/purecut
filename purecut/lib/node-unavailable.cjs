// ts-morph is used exclusively with useInMemoryFileSystem. No native IO in the renderer.
const unavailable = () => { throw new Error('Native filesystem is unavailable in the PureCut compiler'); };
module.exports = new Proxy({platform: () => 'browser', EOL:'\n', constants:{}, promises:{}}, {get(target, key) {return key in target ? target[key] : unavailable;}});

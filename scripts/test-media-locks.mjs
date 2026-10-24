// Test adapter for the Web Locks behaviors used by staging: named queues,
// nonblocking probes, and automatic release when a tab disappears.
export function testMediaLocks() {
  const held = new Map(), queues = new Map();
  const pump = name => {
    if (held.has(name)) return;
    const next = queues.get(name)?.shift();
    if (!next) return;
    const finish = (error, value) => {
      if (held.get(name) !== finish) return;
      held.delete(name);
      if (error) next.reject(error); else next.resolve(value);
      pump(name);
    };
    held.set(name, finish);
    Promise.resolve().then(() => next.run({ name })).then(value => finish(null, value), error => finish(error));
  };
  return {
    request(name, options, run) {
      if (typeof options === 'function') { run = options; options = {}; }
      if (options.ifAvailable && (held.has(name) || queues.get(name)?.length))
        return Promise.resolve().then(() => run(null));
      return new Promise((resolve, reject) => {
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push({ run, resolve, reject });
        pump(name);
      });
    },
    lose(name) { held.get(name)?.(null); },
  };
}

'use strict';
const crypto = require('crypto');

// Content-addressed object store, shared by every repository in the simulator
// (including the simulated GitHub server), so push/fetch never copy objects.
class ObjectStore {
  constructor() {
    this.objects = new Map();
  }

  static hash(obj) {
    return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
  }

  put(obj) {
    const h = ObjectStore.hash(obj);
    if (!this.objects.has(h)) this.objects.set(h, obj);
    return h;
  }

  hashBlob(content) {
    return ObjectStore.hash({ type: 'blob', content });
  }

  blob(content) {
    return this.put({ type: 'blob', content });
  }

  content(h) {
    const o = this.objects.get(h);
    return o ? o.content : undefined;
  }

  commit(h) {
    const o = this.objects.get(h);
    return o && o.type === 'commit' ? o : null;
  }

  commitsByPrefix(prefix) {
    const out = [];
    for (const [h, o] of this.objects) if (o.type === 'commit' && h.startsWith(prefix)) out.push(h);
    return out;
  }
}

module.exports = { ObjectStore };

'use strict';
/* Document store on SQLite (Node's built-in node:sqlite, no native modules to compile). */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = ['accounts', 'trades', 'levels', 'socials', 'orders', 'drawings', 'archive', 'meta', 'ai'];

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY (coll, id))`);
  const q = {
    get: db.prepare('SELECT body FROM docs WHERE coll = ? AND id = ?'),
    list: db.prepare('SELECT id, body FROM docs WHERE coll = ? ORDER BY id'),
    put: db.prepare('INSERT INTO docs (coll, id, body, updated) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET body = excluded.body, updated = excluded.updated'),
    del: db.prepare('DELETE FROM docs WHERE coll = ? AND id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM docs WHERE coll != ?'),
    clear: db.prepare('DELETE FROM docs WHERE coll = ?')
  };
  return {
    raw: db,
    get(coll, id) { const r = q.get.get(coll, id); return r ? JSON.parse(r.body) : null; },
    list(coll) { return q.list.all(coll).map(r => Object.assign(JSON.parse(r.body), { id: r.id })); },
    put(coll, id, body) { const b = Object.assign({}, body); delete b.id; q.put.run(coll, id, JSON.stringify(b), Date.now()); },
    del(coll, id) { q.del.run(coll, id); },
    isEmpty() { return q.count.get('ai').n === 0; },
    clear(coll) { q.clear.run(coll); },
    snapshot() {
      const data = {};
      for (const c of ['accounts', 'trades', 'levels', 'socials', 'orders', 'drawings', 'archive']) data[c] = this.list(c);
      const meta = {};
      for (const m of this.list('meta')) { const id = m.id; delete m.id; meta[id] = m; }
      return { data, meta };
    },
    importAll(dump) {
      db.exec('BEGIN');
      try {
        for (const c of ['accounts', 'trades', 'levels', 'socials', 'orders', 'drawings', 'archive', 'meta']) this.clear(c);
        for (const [c, rows] of Object.entries(dump.data || {})) {
          if (!COLLECTIONS.includes(c)) continue;
          for (const r of rows) if (r && r.id) this.put(c, String(r.id), r);
        }
        for (const [name, body] of Object.entries(dump.meta || {})) this.put('meta', name, body || {});
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}

module.exports = { open, COLLECTIONS };

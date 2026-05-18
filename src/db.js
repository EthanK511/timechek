const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

function createDatabase(filename = path.join(process.cwd(), 'data', 'timechek.db')) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  const db = new sqlite3.Database(filename);

  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) return reject(err);
        return resolve({ id: this.lastID, changes: this.changes });
      });
    });

  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        return resolve(row);
      });
    });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        return resolve(rows);
      });
    });

  const exec = (sql) =>
    new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    });

  const close = () =>
    new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) return reject(err);
        return resolve();
      });
    });

  const init = async () => {
    await exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS huddles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS availability_windows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        huddle_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        proposer_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (huddle_id) REFERENCES huddles(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_id INTEGER NOT NULL,
        voter_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (window_id, voter_name),
        FOREIGN KEY (window_id) REFERENCES availability_windows(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS find_time_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        creator_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        expected_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS find_time_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        timezone_label TEXT NOT NULL,
        start_time_utc TEXT NOT NULL,
        end_time_utc TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, user_id),
        FOREIGN KEY (session_id) REFERENCES find_time_sessions(id) ON DELETE CASCADE
      );
    `);
  };

  return { db, run, get, all, exec, close, init };
}

module.exports = { createDatabase };

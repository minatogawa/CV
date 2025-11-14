const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'publications.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS Journals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      issn TEXT,
      impact_factor REAL,
      quartile TEXT,
      type TEXT NOT NULL CHECK (type IN ('WOS', 'SCOPUS')),
      image_url TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS Publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      authors TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER NOT NULL,
      doi TEXT,
      journal_id INTEGER NOT NULL,
      FOREIGN KEY (journal_id) REFERENCES Journals(id) ON DELETE SET NULL
    )
  `);

  db.all(`PRAGMA table_info(Journals)`, (err, columns) => {
    if (err) {
      console.error('Failed to inspect Journals schema', err);
      return;
    }

    const hasImageUrl = columns.some((col) => col.name === 'image_url');
    if (!hasImageUrl) {
      db.run(`ALTER TABLE Journals ADD COLUMN image_url TEXT`, (alterErr) => {
        if (alterErr) {
          console.error('Failed to add image_url column to Journals', alterErr);
        }
      });
    }
  });

  db.all(`PRAGMA table_info(Publications)`, (err, columns) => {
    if (err) {
      console.error('Failed to inspect Publications schema', err);
      return;
    }

    const journalColumn = columns.find((col) => col.name === 'journal_id');
    if (journalColumn && journalColumn.notnull === 0) {
      db.get(`SELECT COUNT(*) as nullCount FROM Publications WHERE journal_id IS NULL`, (countErr, row) => {
        if (countErr) {
          console.error('Failed to verify journal_id null count', countErr);
          return;
        }

        if (row && row.nullCount > 0) {
          console.error(
            'Cannot migrate Publications.journal_id to NOT NULL because there are rows without a journal. Please update or remove those rows manually.'
          );
          return;
        }

        db.serialize(() => {
          db.run(`
            CREATE TABLE IF NOT EXISTS Publications_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              authors TEXT NOT NULL,
              title TEXT NOT NULL,
              year INTEGER NOT NULL,
              doi TEXT,
              journal_id INTEGER NOT NULL,
              FOREIGN KEY (journal_id) REFERENCES Journals(id) ON DELETE SET NULL
            )
          `);

          db.run(
            `
            INSERT INTO Publications_new (id, authors, title, year, doi, journal_id)
            SELECT id, authors, title, year, doi, journal_id FROM Publications
          `,
            (insertErr) => {
              if (insertErr) {
                console.error('Failed to migrate Publications data', insertErr);
                return;
              }

              db.run(`DROP TABLE Publications`, (dropErr) => {
                if (dropErr) {
                  console.error('Failed to drop old Publications table', dropErr);
                  return;
                }

                db.run(`ALTER TABLE Publications_new RENAME TO Publications`, (renameErr) => {
                  if (renameErr) {
                    console.error('Failed to rename Publications table', renameErr);
                  }
                });
              });
            }
          );
        });
      });
    }
  });
});

module.exports = db;

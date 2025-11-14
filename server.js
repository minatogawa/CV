require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./database');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/parse_publication', async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text is required' });
  }

  try {
    const journals = await dbAll('SELECT id, name FROM Journals ORDER BY name');
    const journalNames = journals.map((journal) => journal.name).join(', ');
    const systemPrompt = `
      Você é um assistente que extrai metadados de publicações científicas.
      Utilize somente os seguintes nomes de revistas ao definir "journal_name": ${journalNames || 'nenhuma revista cadastrada'}.
      Responda APENAS com um JSON minificado no formato:
      {"authors": "...", "title": "...", "year": 2024, "doi": "...", "journal_name": "..."}
      - Use null para qualquer campo desconhecido.
      - Se a revista não estiver na lista fornecida, defina "journal_name": null.
    `;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt.trim() },
        { role: 'user', content: text }
      ]
    });

    const aiContent = completion.choices[0]?.message?.content;
    if (!aiContent) {
      throw new Error('Empty AI response');
    }

    const parsed = JSON.parse(aiContent);
    const normalizedJournal =
      typeof parsed.journal_name === 'string' ? parsed.journal_name.toLowerCase() : null;
    const matchedJournal =
      normalizedJournal && journals.find((journal) => journal.name.toLowerCase() === normalizedJournal);

    res.json({
      authors: parsed.authors || '',
      title: parsed.title || '',
      year: parsed.year ?? null,
      doi: parsed.doi || null,
      matched_journal_id: matchedJournal ? matchedJournal.id : null
    });
  } catch (error) {
    console.error('Failed to parse publication text', error);
    res.status(500).json({ error: 'Não foi possível processar o texto com a IA.' });
  }
});

app.post('/api/journals', (req, res) => {
  const { name, issn, impact_factor, quartile, type, image_url } = req.body;

  if (!name || !type || !['WOS', 'SCOPUS'].includes(type)) {
    return res.status(400).json({ error: 'Invalid journal data' });
  }

  const stmt = `INSERT INTO Journals (name, issn, impact_factor, quartile, type, image_url)
                VALUES (?, ?, ?, ?, ?, ?)`;

  db.run(
    stmt,
    [name, issn || null, impact_factor || null, quartile || null, type, image_url || null],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to save journal' });
      }

      res.status(201).json({ id: this.lastID });
    }
  );
});

app.get('/api/journals/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM Journals WHERE id = ?', [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch journal' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Journal not found' });
    }

    res.json(row);
  });
});

app.put('/api/journals/:id', (req, res) => {
  const { id } = req.params;
  const { name, issn, impact_factor, quartile, type, image_url } = req.body;

  if (!name || !type || !['WOS', 'SCOPUS'].includes(type)) {
    return res.status(400).json({ error: 'Invalid journal data' });
  }

  const stmt = `
    UPDATE Journals
    SET name = ?, issn = ?, impact_factor = ?, quartile = ?, type = ?, image_url = ?
    WHERE id = ?
  `;

  db.run(
    stmt,
    [name, issn || null, impact_factor || null, quartile || null, type, image_url || null, id],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to update journal' });
      }

      if (this.changes === 0) {
        return res.status(404).json({ error: 'Journal not found' });
      }

      res.json({ success: true });
    }
  );
});

app.delete('/api/journals/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM Journals WHERE id = ?', [id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete journal' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Journal not found' });
    }

    res.status(204).send();
  });
});

app.get('/api/journals', (req, res) => {
  db.all('SELECT * FROM Journals ORDER BY name', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch journals' });
    }
    res.json(rows);
  });
});

app.post('/api/publications', (req, res) => {
  const { authors, title, year, doi, journal_id } = req.body;

  if (!authors || !title || !year) {
    return res.status(400).json({ error: 'Missing required publication fields' });
  }

  const parsedJournalId = Number(journal_id);
  if (!journal_id || Number.isNaN(parsedJournalId)) {
    return res.status(400).json({ error: 'journal_id is required' });
  }

  const stmt = `INSERT INTO Publications (authors, title, year, doi, journal_id)
                VALUES (?, ?, ?, ?, ?)`;

  db.run(stmt, [authors, title, year, doi || null, parsedJournalId], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to save publication' });
    }

    res.status(201).json({ id: this.lastID });
  });
});

app.get('/api/publications/:id', (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM Publications WHERE id = ?', [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch publication' });
    }
    if (!row) {
      return res.status(404).json({ error: 'Publication not found' });
    }
    res.json(row);
  });
});

app.put('/api/publications/:id', (req, res) => {
  const { id } = req.params;
  const { authors, title, year, doi, journal_id } = req.body;

  if (!authors || !title || !year) {
    return res.status(400).json({ error: 'Missing required publication fields' });
  }

  const parsedJournalId = Number(journal_id);
  if (!journal_id || Number.isNaN(parsedJournalId)) {
    return res.status(400).json({ error: 'journal_id is required' });
  }

  const stmt = `
    UPDATE Publications
    SET authors = ?, title = ?, year = ?, doi = ?, journal_id = ?
    WHERE id = ?
  `;

  db.run(stmt, [authors, title, year, doi || null, parsedJournalId, id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to update publication' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Publication not found' });
    }

    res.json({ success: true });
  });
});

app.delete('/api/publications/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM Publications WHERE id = ?', [id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to delete publication' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Publication not found' });
    }

    res.status(204).send();
  });
});

app.get('/api/publications_list', (req, res) => {
  const query = `
    SELECT Publications.id,
           Publications.authors,
           Publications.title,
           Publications.year,
           Publications.doi,
           Journals.id AS journal_id,
           Journals.name AS journal_name,
           Journals.type AS journal_type,
           Journals.image_url AS journal_image_url,
           Journals.quartile AS journal_quartile,
           Journals.impact_factor AS journal_impact_factor
    FROM Publications
    LEFT JOIN Journals ON Publications.journal_id = Journals.id
    ORDER BY Publications.year DESC, Publications.title ASC
  `;

  db.all(query, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch publications' });
    }
    res.json(rows);
  });
});

app.get('/api/kpis', async (req, res) => {
  const rawStart = Number(req.query.startYear);
  const rawEnd = Number(req.query.endYear);
  const startYear = Number.isFinite(rawStart) ? rawStart : 0;
  const endYear = Number.isFinite(rawEnd) ? rawEnd : 9999;

  if (startYear > endYear) {
    return res.status(400).json({ error: 'startYear must be less than or equal to endYear' });
  }

  try {
    const yearlyRows = await dbAll(
      `
      SELECT Publications.year as year,
             Journals.type as type,
             COUNT(Publications.id) as count
      FROM Publications
      LEFT JOIN Journals ON Publications.journal_id = Journals.id
      WHERE Publications.year BETWEEN ? AND ?
      GROUP BY Publications.year, Journals.type
      ORDER BY Publications.year DESC
      `,
      [startYear, endYear]
    );

    const totalsRow = await dbGet(
      `
      SELECT
        SUM(CASE WHEN Journals.type = 'WOS' THEN 1 ELSE 0 END) AS wos_count,
        SUM(CASE WHEN Journals.type = 'SCOPUS' THEN 1 ELSE 0 END) AS scopus_count,
        SUM(CASE WHEN Journals.type = 'WOS' THEN IFNULL(Journals.impact_factor, 0) ELSE 0 END) AS totalImpactFactor,
        SUM(CASE WHEN Journals.type = 'SCOPUS' THEN IFNULL(Journals.impact_factor, 0) ELSE 0 END) AS totalCiteScore
      FROM Publications
      LEFT JOIN Journals ON Publications.journal_id = Journals.id
      WHERE Publications.year BETWEEN ? AND ?
      `,
      [startYear, endYear]
    );

    const resultsMap = {};

    yearlyRows.forEach((row) => {
      if (!resultsMap[row.year]) {
        resultsMap[row.year] = { year: row.year, wos_count: 0, scopus_count: 0 };
      }

      if (row.type === 'WOS') {
        resultsMap[row.year].wos_count = row.count;
      } else if (row.type === 'SCOPUS') {
        resultsMap[row.year].scopus_count = row.count;
      }
    });

    const yearlyBreakdown = Object.values(resultsMap).sort((a, b) => b.year - a.year);
    const totalPapers = (totalsRow?.wos_count || 0) + (totalsRow?.scopus_count || 0);

    res.json({
      yearlyBreakdown,
      rangeTotals: {
        totalPapers,
        totalImpactFactor: totalsRow?.totalImpactFactor || 0,
        totalCiteScore: totalsRow?.totalCiteScore || 0
      }
    });
  } catch (error) {
    console.error('Failed to fetch KPIs', error);
    res.status(500).json({ error: 'Failed to fetch KPIs' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

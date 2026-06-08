/**
 * server.js — Backend Express + SQLite para Counter App
 *
 * Expone una REST API con JWT auth para gestionar contadores,
 * historial de clics, exportación/importación CSV.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// node:sqlite está integrado en Node.js ≥ 22.5 (--experimental-sqlite en v22)
const { DatabaseSync } = require('node:sqlite');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'counter_app_secret_key_change_in_production';

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// multer en memoria para procesar el CSV sin guardarlo en disco
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Base de datos SQLite ─────────────────────────────────────────────────────
// DB_PATH permite apuntar a un volumen persistente en Railway (ej: /data/counter.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'counter.db');
const db = new DatabaseSync(DB_PATH);

// Activa WAL mode para mejor performance en escrituras concurrentes
db.exec("PRAGMA journal_mode = WAL");

// Crea las tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    email      TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS counters (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    color           TEXT    NOT NULL DEFAULT '#6366f1',
    current_value   REAL    NOT NULL DEFAULT 0,
    initial_value   REAL    NOT NULL DEFAULT 0,
    step            REAL    NOT NULL DEFAULT 1,
    is_favorite     INTEGER NOT NULL DEFAULT 0,
    last_reset_year INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS counter_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    counter_id   INTEGER NOT NULL,
    action       TEXT    NOT NULL,
    value_before REAL    NOT NULL,
    value_after  REAL    NOT NULL,
    increment    REAL    NOT NULL DEFAULT 0,
    timestamp    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (counter_id) REFERENCES counters(id) ON DELETE CASCADE
  );
`);

// ─── Migraciones de esquema ───────────────────────────────────────────────────
try {
  db.exec('ALTER TABLE counters ADD COLUMN last_reset_year INTEGER NOT NULL DEFAULT 0');
} catch (_) { /* columna ya existe, ignorar */ }

try {
  db.exec('ALTER TABLE counters ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
} catch (_) { /* columna ya existe, ignorar */ }

// Inicializa last_reset_year = año actual en filas antiguas (DEFAULT 0 = sin inicializar)
db.exec(`UPDATE counters SET last_reset_year = ${new Date().getFullYear()} WHERE last_reset_year = 0`);

// Inicializa sort_order usando el id como base de orden natural
db.exec('UPDATE counters SET sort_order = id WHERE sort_order = 0');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Middleware que verifica el JWT y adjunta el userId al request */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

/** Registra un evento en counter_history y actualiza updated_at del contador */
function recordHistory(counterId, action, valueBefore, valueAfter, increment) {
  db.prepare(`
    INSERT INTO counter_history (counter_id, action, value_before, value_after, increment)
    VALUES (?, ?, ?, ?, ?)
  `).run(counterId, action, valueBefore, valueAfter, increment);

  db.prepare(`UPDATE counters SET updated_at = datetime('now') WHERE id = ?`).run(counterId);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** POST /api/auth/register — Crea un usuario nuevo */
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)'
    ).run(username.trim(), email.trim().toLowerCase(), hash);

    const token = jwt.sign({ userId: result.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, username: username.trim() });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      res.status(409).json({ error: 'El usuario o email ya está registrado' });
    } else {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
});

/** POST /api/auth/login — Autentica y devuelve JWT */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email y contraseña requeridos' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// ─── Counters CRUD ────────────────────────────────────────────────────────────

/** GET /api/counters — Devuelve todos los contadores del usuario (favoritos primero).
 *
 *  Antes de responder ejecuta el reset anual automático:
 *  - Si last_reset_year < año actual → inserta evento 'year_reset' en el historial
 *    y vuelve current_value al initial_value, preservando todos los registros.
 */
app.get('/api/counters', authMiddleware, (req, res) => {
  const currentYear = new Date().getFullYear();

  const toReset = db.prepare(`
    SELECT * FROM counters
    WHERE user_id = ? AND last_reset_year < ?
  `).all(req.userId, currentYear);

  if (toReset.length > 0) {
    const stmtHistory = db.prepare(`
      INSERT INTO counter_history
        (counter_id, action, value_before, value_after, increment, timestamp)
      VALUES (?, 'year_reset', ?, ?, 0, ?)
    `);
    const stmtReset = db.prepare(`
      UPDATE counters
      SET current_value = initial_value,
          last_reset_year = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);

    db.exec('BEGIN');
    try {
      for (const c of toReset) {
        // El timestamp del evento queda fijo en el 1° de enero del año nuevo
        const resetTs = `${currentYear}-01-01 00:00:00`;
        stmtHistory.run(c.id, c.current_value, c.initial_value, resetTs);
        stmtReset.run(currentYear, c.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('[Year Reset] Error:', err);
    }
  }

  const counters = db.prepare(`
    SELECT * FROM counters
    WHERE user_id = ?
    ORDER BY is_favorite DESC, sort_order ASC, id ASC
  `).all(req.userId);

  res.json(counters);
});

/** POST /api/counters — Crea un contador nuevo */
app.post('/api/counters', authMiddleware, (req, res) => {
  const { name, color, initial_value = 0, step = 1 } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'El nombre es requerido' });
  }

  const { nextOrder } = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM counters WHERE user_id = ?'
  ).get(req.userId);

  const result = db.prepare(`
    INSERT INTO counters (user_id, name, color, current_value, initial_value, step, last_reset_year, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.userId, name.trim(), color || '#6366f1', initial_value, initial_value, step,
         new Date().getFullYear(), nextOrder);

  const counter = db.prepare('SELECT * FROM counters WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(counter);
});

/** PUT /api/counters/reorder — Persiste el nuevo orden de los contadores.
 *  Body: { ids: [4, 1, 3, 2] }  (IDs en el orden deseado, favs primero)
 *  Asigna sort_order = índice a cada ID recibido.
 */
app.put('/api/counters/reorder', authMiddleware, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids requerido' });
  }
  const stmt = db.prepare('UPDATE counters SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, index) => stmt.run(index, id, req.userId));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err.message });
  }
  res.json({ success: true });
});

/** PUT /api/counters/:id — Actualiza nombre, color, step, is_favorite */
app.put('/api/counters/:id', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  const { name, color, step, is_favorite } = req.body;
  db.prepare(`
    UPDATE counters SET
      name        = COALESCE(?, name),
      color       = COALESCE(?, color),
      step        = COALESCE(?, step),
      is_favorite = COALESCE(?, is_favorite),
      updated_at  = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    color || null,
    step !== undefined ? step : null,
    is_favorite !== undefined ? (is_favorite ? 1 : 0) : null,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM counters WHERE id = ?').get(req.params.id));
});

/** DELETE /api/counters/:id — Elimina un contador y su historial */
app.delete('/api/counters/:id', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  db.prepare('DELETE FROM counters WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Acciones del contador ────────────────────────────────────────────────────

/** POST /api/counters/:id/increment — Suma el step al valor actual */
app.post('/api/counters/:id/increment', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  const newValue = counter.current_value + counter.step;
  db.prepare('UPDATE counters SET current_value = ? WHERE id = ?').run(newValue, counter.id);
  recordHistory(counter.id, 'increment', counter.current_value, newValue, counter.step);

  res.json({ current_value: newValue });
});

/** POST /api/counters/:id/decrement — Resta el step al valor actual */
app.post('/api/counters/:id/decrement', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  const newValue = counter.current_value - counter.step;
  db.prepare('UPDATE counters SET current_value = ? WHERE id = ?').run(newValue, counter.id);
  recordHistory(counter.id, 'decrement', counter.current_value, newValue, -counter.step);

  res.json({ current_value: newValue });
});

/** POST /api/counters/:id/reset — Vuelve al valor inicial */
app.post('/api/counters/:id/reset', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  db.prepare('UPDATE counters SET current_value = ? WHERE id = ?')
    .run(counter.initial_value, counter.id);
  recordHistory(counter.id, 'reset', counter.current_value, counter.initial_value, 0);

  res.json({ current_value: counter.initial_value });
});

// ─── Historial ────────────────────────────────────────────────────────────────

/** GET /api/counters/:id/history — Devuelve el historial de un contador */
app.get('/api/counters/:id/history', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT id FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  const history = db.prepare(`
    SELECT * FROM counter_history
    WHERE counter_id = ?
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(req.params.id);
  res.json(history);
});

// ─── Exportación CSV ──────────────────────────────────────────────────────────

/**
 * GET /api/counters/export — Exporta todos los contadores del usuario como CSV.
 * GET /api/counters/:id/export — Exporta un contador específico.
 *
 * Estructura CSV:
 *   Marca de tiempo, fecha, hora, valor de contador, incremento, nombre contador
 */
function buildCSV(counters, userId) {
  const lines = ['Marca de tiempo\tfecha\thora\tvalor de contador\tincremento\tnombre contador'];

  for (const counter of counters) {
    // Fila de creación del contador
    const [dateC, timeC] = counter.created_at.split(' ');
    lines.push([
      counter.created_at,
      dateC,
      timeC,
      counter.initial_value,
      0,
      counter.name
    ].join('\t'));

    // Filas del historial
    const history = db.prepare(`
      SELECT * FROM counter_history WHERE counter_id = ? ORDER BY timestamp ASC
    `).all(counter.id);

    for (const h of history) {
      const [date, time] = h.timestamp.split(' ');
      lines.push([h.timestamp, date, time, h.value_after, h.increment, counter.name].join('\t'));
    }
  }

  return lines.join('\n');
}

app.get('/api/counters/export', authMiddleware, (req, res) => {
  const counters = db.prepare('SELECT * FROM counters WHERE user_id = ?').all(req.userId);
  const csv = buildCSV(counters, req.userId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contadores_export.csv"');
  res.send('﻿' + csv); // BOM para compatibilidad con Excel
});

app.get('/api/counters/:id/export', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  const csv = buildCSV([counter], req.userId);
  const filename = `contador_${counter.name.replace(/[^a-z0-9]/gi, '_')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
});

// ─── Importación CSV ──────────────────────────────────────────────────────────

/**
 * POST /api/counters/import — Importa contadores desde un CSV.
 * Soporta el formato estándar de la app y el formato de exportación propio.
 *
 * Formato esperado (TSV):
 *   Marca de tiempo\tfecha\thora\tvalor de contador\tincremento\tnombre contador
 */
app.post('/api/counters/import', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Archivo CSV requerido' });

  try {
    // Elimina BOM (UTF-8 con BOM que produce Excel/iOS)
    const text = req.file.buffer.toString('utf-8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length < 2) return res.status(400).json({ error: 'El archivo está vacío o tiene solo encabezado' });

    // Detecta separador: tab tiene prioridad sobre coma
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const header = lines[0].split(sep).map(h => h.trim().toLowerCase());

    // Mapeo flexible de columnas por nombre (soporte español e inglés).
    // Se usan coincidencias exactas o prefijos para evitar falsos positivos
    // como "valor de contador" que contiene "contador" pero no es una columna de nombre.
    const colIndex = {
      timestamp: header.findIndex(h => h.includes('marca') || h.includes('timestamp')),
      value:     header.findIndex(h => h.includes('valor') || h === 'value' || h === 'count'),
      increment: header.findIndex(h => h === 'incremento' || h === 'increment' || h === 'delta' || h.startsWith('incr')),
      name:      header.findIndex(h => h === 'nombre' || h === 'name' || h === 'contador' || h === 'nombre contador' || h === 'counter name'),
    };

    // Nombre de fallback: extraído del nombre del archivo (ej: "Oficina-export.csv" → "Oficina")
    const fileBaseName = (req.file.originalname || '')
      .replace(/-export$/i, '').replace(/_export$/i, '')
      .replace(/\.(csv|tsv|txt)$/i, '').trim() || 'Importado';

    // Calcula el próximo sort_order para ubicar los contadores importados al final
    const { baseOrder } = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS baseOrder FROM counters WHERE user_id = ?'
    ).get(req.userId);
    let importSortOrder = baseOrder;

    // Prepara los statements fuera del loop para eficiencia
    const stmtInsertCounter = db.prepare(`
      INSERT INTO counters (user_id, name, color, current_value, initial_value, step, last_reset_year, sort_order)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const stmtInsertHistory = db.prepare(`
      INSERT INTO counter_history (counter_id, action, value_before, value_after, increment, timestamp)
      VALUES (?, 'import', ?, ?, ?, ?)
    `);
    const stmtGetCounter = db.prepare('SELECT * FROM counters WHERE id = ?');

    // Agrupa filas por nombre de contador
    const counterMap = new Map();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep);
      if (cols.length < 2) continue; // fila vacía o malformada

      const name = (colIndex.name >= 0 ? (cols[colIndex.name] || '').trim() : '') || fileBaseName;
      const value = parseFloat(cols[colIndex.value >= 0 ? colIndex.value : 3]) || 0;
      const increment = colIndex.increment >= 0 ? (parseFloat(cols[colIndex.increment]) || 0) : 0;
      // El timestamp puede traer fracciones de segundo: "2022-01-04 09:11:24.4740" → recortamos a segundos
      const rawTs = colIndex.timestamp >= 0 ? (cols[colIndex.timestamp] || '').trim() : '';
      const ts = rawTs.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1') || new Date().toISOString();

      if (!counterMap.has(name)) {
        counterMap.set(name, { name, entries: [] });
      }
      counterMap.get(name).entries.push({ ts, value, increment });
    }

    if (counterMap.size === 0) {
      return res.status(400).json({ error: 'No se encontraron datos válidos en el archivo' });
    }

    const importedCounters = [];

    // Transacción manual: node:sqlite en v22 no expone .transaction(),
    // se usa BEGIN / COMMIT / ROLLBACK directamente sobre la conexión.
    db.exec('BEGIN');
    try {
      for (const [, data] of counterMap) {
        const firstEntry = data.entries[0];
        const lastEntry  = data.entries[data.entries.length - 1];

        // El valor inicial se infiere: primer_valor - primer_incremento (ej: 1 - 1 = 0)
        const initialValue = firstEntry ? (firstEntry.value - firstEntry.increment) : 0;
        const currentValue = lastEntry  ? lastEntry.value : initialValue;

        const result    = stmtInsertCounter.run(req.userId, data.name, '#6366f1', currentValue, initialValue, new Date().getFullYear(), importSortOrder++);
        const counterId = Number(result.lastInsertRowid); // Number() por si retorna BigInt

        for (let j = 0; j < data.entries.length; j++) {
          const entry = data.entries[j];
          const prev  = j === 0 ? initialValue : data.entries[j - 1].value;
          stmtInsertHistory.run(counterId, prev, entry.value, entry.increment, entry.ts);
        }

        importedCounters.push(stmtGetCounter.get(counterId));
      }
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }
    res.status(201).json({ imported: importedCounters.length, counters: importedCounters });

  } catch (err) {
    console.error('[Import] Error:', err);
    res.status(500).json({ error: `Error al importar: ${err.message}` });
  }
});

// ─── Importación de historial a contador existente ───────────────────────────

/**
 * POST /api/counters/:id/import-history — Agrega registros históricos a un
 * contador ya existente sin crear uno nuevo.
 *
 * Útil para cargar datos de años anteriores de contadores propios.
 * No modifica current_value ni initial_value del contador.
 */
app.post('/api/counters/:id/import-history', authMiddleware, upload.single('file'), (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });
  if (!req.file)  return res.status(400).json({ error: 'Archivo CSV requerido' });

  try {
    const text   = req.file.buffer.toString('utf-8').replace(/^﻿/, '');
    const lines  = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'Archivo vacío o solo encabezado' });

    const sep    = lines[0].includes('\t') ? '\t' : ',';
    const header = lines[0].split(sep).map(h => h.trim().toLowerCase());

    const col = {
      timestamp: header.findIndex(h => h.includes('marca') || h.includes('timestamp')),
      value:     header.findIndex(h => h.includes('valor') || h === 'value' || h === 'count'),
      increment: header.findIndex(h => h === 'incremento' || h === 'increment' || h === 'delta' || h.startsWith('incr')),
    };

    const entries = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep);
      if (cols.length < 2) continue;
      const value     = parseFloat(cols[col.value     >= 0 ? col.value     : 3]) || 0;
      const increment = col.increment >= 0 ? (parseFloat(cols[col.increment]) || 0) : 0;
      const rawTs     = col.timestamp >= 0 ? (cols[col.timestamp] || '').trim() : '';
      const ts        = rawTs.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1') || new Date().toISOString();
      entries.push({ ts, value, increment });
    }

    if (entries.length === 0) return res.status(400).json({ error: 'Sin datos válidos en el archivo' });

    const stmt = db.prepare(`
      INSERT INTO counter_history (counter_id, action, value_before, value_after, increment, timestamp)
      VALUES (?, 'import', ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      for (let j = 0; j < entries.length; j++) {
        const e    = entries[j];
        const prev = j === 0 ? (e.value - e.increment) : entries[j - 1].value;
        stmt.run(counter.id, prev, e.value, e.increment, e.ts);
      }
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }

    res.json({ imported: entries.length });
  } catch (err) {
    console.error('[ImportHistory]', err);
    res.status(500).json({ error: `Error al importar: ${err.message}` });
  }
});

// ─── Análisis ─────────────────────────────────────────────────────────────────

/**
 * GET /api/counters/:id/analytics — Retorna datos agregados por año/mes.
 *
 * Respuesta:
 *   { counter: {id,name,color}, yearlyData: {"2022":[0,…,76],...}, years: ["2022","2026"] }
 *
 * yearlyData[year][mes] = suma de incrementos positivos en ese mes (índice 0=Ene).
 */
app.get('/api/counters/:id/analytics', authMiddleware, (req, res) => {
  const counter = db.prepare('SELECT * FROM counters WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!counter) return res.status(404).json({ error: 'Contador no encontrado' });

  const rows = db.prepare(`
    SELECT
      strftime('%Y', timestamp) AS year,
      strftime('%m', timestamp) AS month,
      SUM(CASE WHEN increment > 0 THEN increment ELSE 0 END) AS added
    FROM counter_history
    WHERE counter_id = ? AND action IN ('increment', 'decrement', 'import')
    GROUP BY year, month
    ORDER BY year, month
  `).all(counter.id);

  const yearlyData = {};
  for (const row of rows) {
    if (!yearlyData[row.year]) yearlyData[row.year] = Array(12).fill(0);
    yearlyData[row.year][parseInt(row.month) - 1] = row.added;
  }

  res.json({
    counter: { id: counter.id, name: counter.name, color: counter.color },
    yearlyData,
    years: Object.keys(yearlyData).sort(),
  });
});

// ─── Ruta catch-all para el SPA ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Counter App corriendo en http://localhost:${PORT}`);
});

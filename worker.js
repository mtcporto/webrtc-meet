// Cloudflare Worker de sinalização WebRTC com estado compartilhado no Turso.
// Configure em Settings > Variables and Secrets:
// TURSO_DATABASE_URL=https://<database>-<organization>.turso.io
// TURSO_AUTH_TOKEN=<database-auth-token>

const PARTICIPANT_TTL_MS = 5 * 60 * 1000;
const SIGNAL_TTL_MS = 2 * 60 * 1000;

export default {
  async fetch(request, env) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
      return json({ success: false, error: 'database_not_configured' }, 500, headers);
    }

    try {
      await ensureSchema(env);
      const url = new URL(request.url);

      if (url.pathname === '/join' && request.method === 'POST') {
        return await joinRoom(request, env, headers);
      }

      if (url.pathname === '/leave' && request.method === 'POST') {
        return await leaveRoom(request, env, headers);
      }

      if (url.pathname === '/signal' && request.method === 'POST') {
        return await sendSignal(request, env, headers);
      }

      if (url.pathname === '/poll' && request.method === 'GET') {
        return await pollRoom(url, env, headers);
      }

      return json({ success: false, error: 'not_found' }, 404, headers);
    } catch (error) {
      console.error('Signaling error:', error);
      return json({ success: false, error: 'signaling_unavailable' }, 500, headers);
    }
  }
};

async function joinRoom(request, env, headers) {
  let { room, id, name } = await request.json();
  room = normalizeRoomId(room);
  if (!room || !id || !name) {
    return json({ success: false, error: 'missing_room_id_or_name' }, 400, headers);
  }

  const now = Date.now();
  const results = await execute(env, [
    statement('DELETE FROM participants WHERE room = ? AND last_seen < ?', [room, now - PARTICIPANT_TTL_MS]),
    statement(
      'INSERT INTO participants (room, id, name, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(room, id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen',
      [room, id, name, now]
    ),
    statement('SELECT id, name, last_seen FROM participants WHERE room = ? ORDER BY last_seen', [room])
  ]);

  return json({ success: true, users: rows(results[2]) }, 200, headers);
}

async function leaveRoom(request, env, headers) {
  let { room, id } = await request.json();
  room = normalizeRoomId(room);
  if (!room || !id) {
    return json({ success: false, error: 'missing_room_or_id' }, 400, headers);
  }

  await execute(env, [
    statement('DELETE FROM participants WHERE room = ? AND id = ?', [room, id]),
    statement('DELETE FROM signals WHERE room = ? AND (sender = ? OR target = ?)', [room, id, id])
  ]);

  return json({ success: true }, 200, headers);
}

async function sendSignal(request, env, headers) {
  let { room, sender, target, type, data } = await request.json();
  room = normalizeRoomId(room);
  if (!room || !sender || !target || !type || data === undefined) {
    return json({ success: false, error: 'missing_signal_data' }, 400, headers);
  }

  const now = Date.now();
  const results = await execute(env, [
    statement('DELETE FROM participants WHERE room = ? AND last_seen < ?', [room, now - PARTICIPANT_TTL_MS]),
    statement('SELECT COUNT(*) AS participant_count FROM participants WHERE room = ? AND id IN (?, ?)', [room, sender, target])
  ]);

  if (Number(rows(results[1])[0].participant_count) !== 2) {
    return json({ success: false, error: 'participant_not_in_room' }, 409, headers);
  }

  await execute(env, [
    statement(
      'INSERT INTO signals (room, sender, target, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [room, sender, target, type, JSON.stringify(data), now]
    ),
    statement(
      'DELETE FROM signals WHERE id NOT IN (SELECT id FROM signals WHERE room = ? ORDER BY id DESC LIMIT 100) OR created_at < ?',
      [room, now - SIGNAL_TTL_MS]
    )
  ]);

  return json({ success: true }, 200, headers);
}

async function pollRoom(url, env, headers) {
  const room = normalizeRoomId(url.searchParams.get('room'));
  const id = url.searchParams.get('id');
  const last = Number(url.searchParams.get('last') || '0');
  if (!room || !id || !Number.isFinite(last)) {
    return json({ success: false, error: 'missing_poll_parameters' }, 400, headers);
  }

  const now = Date.now();
  const results = await execute(env, [
    statement('DELETE FROM participants WHERE room = ? AND last_seen < ?', [room, now - PARTICIPANT_TTL_MS]),
    statement('DELETE FROM signals WHERE room = ? AND created_at < ?', [room, now - SIGNAL_TTL_MS]),
    statement('UPDATE participants SET last_seen = ? WHERE room = ? AND id = ?', [now, room, id]),
    statement('SELECT sender, target, type, payload, created_at FROM signals WHERE room = ? AND target = ? AND created_at > ? ORDER BY id', [room, id, last]),
    statement('SELECT id, name, last_seen FROM participants WHERE room = ? ORDER BY last_seen', [room])
  ]);

  const signals = rows(results[3]).map(signal => ({
    sender: signal.sender,
    target: signal.target,
    type: signal.type,
    data: JSON.parse(signal.payload),
    timestamp: Number(signal.created_at)
  }));
  const users = rows(results[4]).map(user => ({
    id: user.id,
    name: user.name,
    timestamp: Number(user.last_seen)
  }));
  console.log(`Poll: room=${room}, user=${id}, signals=${signals.length}, users=${users.length}`);

  return json({ success: true, signals, users }, 200, headers);
}

let schemaPromise;

function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = execute(env, [
      statement('CREATE TABLE IF NOT EXISTS participants (room TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (room, id))'),
      statement('CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)'),
      statement('CREATE INDEX IF NOT EXISTS signals_target_idx ON signals (room, target, created_at)')
    ]);
  }
  return schemaPromise;
}

async function execute(env, statements) {
  const baseUrl = env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [...statements.map(stmt => ({ type: 'execute', stmt })), { type: 'close' }]
    })
  });

  if (!response.ok) {
    throw new Error(`Turso returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const results = payload.results.slice(0, -1);
  for (const result of results) {
    if (result.type !== 'ok') {
      throw new Error(`Turso query failed: ${JSON.stringify(result)}`);
    }
  }
  return results.map(result => result.response.result);
}

function statement(sql, args = []) {
  return {
    sql,
    args: args.map(value => ({
      type: typeof value === 'number' ? 'integer' : 'text',
      value: String(value)
    }))
  };
}

function rows(result) {
  const columns = result.cols.map(column => column.name);
  return result.rows.map(values => Object.fromEntries(values.map((value, index) => [columns[index], value.value])));
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}

function normalizeRoomId(room) {
  return String(room || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

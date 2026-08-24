// Cloudflare Worker de sinalização WebRTC com estado compartilhado no Turso.
// Configure em Settings > Variables and Secrets:
// TURSO_DATABASE_URL=https://<database>-<organization>.turso.io
// TURSO_AUTH_TOKEN=<database-auth-token>

const PARTICIPANT_TTL_MS = 5 * 60 * 1000;
const PARTICIPANT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
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
  let { room, id, participantId, previousConnectionId, name, generation } = await request.json();
  room = normalizeRoomId(room);
  participantId = String(participantId || id || '');
  previousConnectionId = String(previousConnectionId || '');
  generation = normalizeGeneration(generation);
  if (!room || !id || !participantId || !name || generation === null) {
    return json({ success: false, error: 'missing_room_id_or_name' }, 400, headers);
  }

  const now = Date.now();
  const cleanupStatements = participantCleanupStatements(room, now);
  const results = await execute(env, [
    ...cleanupStatements,
    activateParticipantStatement(room, participantId, id, name, generation, now),
    legacyShadowCleanupStatement(
      room, participantId, id, previousConnectionId, generation
    ),
    statement(
      'SELECT signal_cursor FROM participants_v2 WHERE room = ? AND participant_id = ? AND connection_id = ? AND generation = ? AND active = 1',
      [room, participantId, id, generation]
    ),
    participantListStatement(room, now)
  ]);

  const session = rows(results[cleanupStatements.length + 2])[0];
  if (!session) {
    return json({ success: false, error: 'session_not_active', presenceProtocol: 2 }, 409, headers);
  }

  return json({
    success: true,
    users: rows(results[cleanupStatements.length + 3]),
    signalCursor: Number(session.signal_cursor || 0),
    presenceProtocol: 2
  }, 200, headers);
}

async function leaveRoom(request, env, headers) {
  let { room, id, participantId, previousConnectionId, name, generation } = await request.json();
  room = normalizeRoomId(room);
  participantId = String(participantId || id || '');
  previousConnectionId = String(previousConnectionId || '');
  name = String(name || '');
  generation = normalizeGeneration(generation);
  if (!room || !id || !participantId || generation === null) {
    return json({ success: false, error: 'missing_room_or_id' }, 400, headers);
  }

  const now = Date.now();
  await execute(env, [
    // Uma saida atrasada da pagina antiga nao pode apagar sinais nem a presenca
    // da nova geracao que assumiu o mesmo ID durante o reload.
    statement(
      'DELETE FROM signals WHERE room = ? AND (sender = ? OR target = ?) AND EXISTS (SELECT 1 FROM participants_v2 WHERE room = ? AND participant_id = ? AND connection_id = ? AND generation = ? AND active = 1)',
      [room, id, id, room, participantId, id, generation]
    ),
    statement(
      'INSERT INTO participants_v2 (room, participant_id, connection_id, name, generation, active, last_seen) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(room, participant_id) DO UPDATE SET connection_id = excluded.connection_id, generation = excluded.generation, active = 0, last_seen = excluded.last_seen WHERE excluded.generation > participants_v2.generation OR (excluded.generation = participants_v2.generation AND excluded.connection_id = participants_v2.connection_id)',
      [room, participantId, id, name, generation, now]
    ),
    statement(
      'DELETE FROM participants WHERE room = ? AND id IN (?, ?)',
      [room, id, previousConnectionId]
    )
  ]);

  return json({ success: true, presenceProtocol: 2 }, 200, headers);
}

async function sendSignal(request, env, headers) {
  let { room, sender, participantId, target, type, data, generation } = await request.json();
  room = normalizeRoomId(room);
  participantId = String(participantId || sender || '');
  generation = normalizeGeneration(generation);
  if (!room || !sender || !participantId || !target || !type || data === undefined || generation === null) {
    return json({ success: false, error: 'missing_signal_data' }, 400, headers);
  }

  const now = Date.now();
  const cleanupStatements = participantCleanupStatements(room, now);
  const results = await execute(env, [
    ...cleanupStatements,
    statement(
      'SELECT EXISTS(SELECT 1 FROM participants_v2 WHERE room = ? AND participant_id = ? AND connection_id = ? AND generation = ? AND active = 1) AS sender_v2, EXISTS(SELECT 1 FROM participants WHERE room = ? AND id = ? AND last_seen >= ? AND NOT EXISTS(SELECT 1 FROM participants_v2 WHERE room = ? AND connection_id = ?)) AS sender_legacy, EXISTS(SELECT 1 FROM participants_v2 WHERE room = ? AND connection_id = ? AND active = 1) AS target_v2, EXISTS(SELECT 1 FROM participants WHERE room = ? AND id = ? AND last_seen >= ? AND NOT EXISTS(SELECT 1 FROM participants_v2 WHERE room = ? AND connection_id = ?)) AS target_legacy',
      [
        room, participantId, sender, generation,
        room, sender, now - PARTICIPANT_TTL_MS, room, sender,
        room, target,
        room, target, now - PARTICIPANT_TTL_MS, room, target
      ]
    )
  ]);

  const presence = rows(results[cleanupStatements.length])[0];
  const senderPresent = Number(presence.sender_v2) === 1 || (
    generation === 0 && participantId === sender && Number(presence.sender_legacy) === 1
  );
  const targetPresent = Number(presence.target_v2) === 1 || Number(presence.target_legacy) === 1;
  if (!senderPresent || !targetPresent) {
    return json({ success: false, error: 'participant_not_in_room' }, 409, headers);
  }

  await execute(env, [
    statement(
      'INSERT INTO signals (room, sender, target, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [room, sender, target, type, JSON.stringify(data), now]
    ),
    statement(
      'DELETE FROM signals WHERE room = ? AND id NOT IN (SELECT id FROM signals WHERE room = ? ORDER BY id DESC LIMIT 100)',
      [room, room]
    ),
    statement('DELETE FROM signals WHERE created_at < ?', [now - SIGNAL_TTL_MS])
  ]);

  return json({ success: true, presenceProtocol: 2 }, 200, headers);
}

async function pollRoom(url, env, headers) {
  const room = normalizeRoomId(url.searchParams.get('room'));
  const id = url.searchParams.get('id');
  const participantId = String(url.searchParams.get('participantId') || id || '');
  const previousConnectionId = String(url.searchParams.get('previousConnectionId') || '');
  const name = url.searchParams.get('name');
  const generation = normalizeGeneration(url.searchParams.get('generation'));
  const legacyLastTimestamp = Number(url.searchParams.get('last') || '0');
  const hasSignalIdCursor = url.searchParams.has('lastId');
  const lastSignalId = Number(url.searchParams.get('lastId') || '0');
  if (!room || !id || !participantId || generation === null || !Number.isFinite(legacyLastTimestamp) || !Number.isFinite(lastSignalId)) {
    return json({ success: false, error: 'missing_poll_parameters' }, 400, headers);
  }

  const now = Date.now();
  // `last` é mantido temporariamente para clientes antigos. IDs do banco são
  // o cursor confiável: relógios do navegador e do servidor podem divergir.
  const signalCursorColumn = hasSignalIdCursor ? 'id' : 'created_at';
  const signalCursor = hasSignalIdCursor ? lastSignalId : legacyLastTimestamp;
  const cleanupStatements = participantCleanupStatements(room, now);
  const heartbeatStatements = name
    ? [activateParticipantStatement(room, participantId, id, name, generation, now)]
    : [
      statement(
        'INSERT OR IGNORE INTO participants_v2 (room, participant_id, connection_id, name, generation, active, last_seen, signal_cursor) SELECT room, id, id, name, 0, 1, ?, (SELECT COALESCE(MAX(id), 0) FROM signals WHERE room = ?) FROM participants WHERE room = ? AND id = ?',
        [now, room, room, id]
      ),
      statement(
        'UPDATE participants_v2 SET last_seen = ? WHERE room = ? AND participant_id = ? AND connection_id = ? AND generation = 0 AND active = 1',
        [now, room, participantId, id]
      )
    ];
  const signalResultIndex = cleanupStatements.length + 2 + heartbeatStatements.length;
  const usersResultIndex = signalResultIndex + 1;
  const sessionResultIndex = usersResultIndex + 1;
  const results = await execute(env, [
    ...cleanupStatements,
    statement('DELETE FROM signals WHERE room = ? AND created_at < ?', [room, now - SIGNAL_TTL_MS]),
    ...heartbeatStatements,
    legacyShadowCleanupStatement(
      room, participantId, id, previousConnectionId, generation
    ),
    statement(
      `SELECT s.id, s.sender, s.target, s.type, s.payload, s.created_at FROM signals s WHERE s.room = ? AND s.target = ? AND s.${signalCursorColumn} > ? AND EXISTS(SELECT 1 FROM participants_v2 self WHERE self.room = s.room AND self.participant_id = ? AND self.connection_id = ? AND self.generation = ? AND self.active = 1) AND (EXISTS(SELECT 1 FROM participants_v2 sender WHERE sender.room = s.room AND sender.connection_id = s.sender AND sender.active = 1) OR EXISTS(SELECT 1 FROM participants legacy_sender WHERE legacy_sender.room = s.room AND legacy_sender.id = s.sender AND legacy_sender.last_seen >= ? AND NOT EXISTS(SELECT 1 FROM participants_v2 migrated_sender WHERE migrated_sender.room = s.room AND migrated_sender.connection_id = s.sender))) ORDER BY s.id`,
      [room, id, signalCursor, participantId, id, generation, now - PARTICIPANT_TTL_MS]
    ),
    participantListStatement(room, now),
    statement(
      'SELECT EXISTS(SELECT 1 FROM participants_v2 WHERE room = ? AND participant_id = ? AND connection_id = ? AND generation = ? AND active = 1) AS session_active',
      [room, participantId, id, generation]
    )
  ]);

  const signals = rows(results[signalResultIndex]).map(signal => ({
    id: Number(signal.id),
    sender: signal.sender,
    target: signal.target,
    type: signal.type,
    data: JSON.parse(signal.payload),
    timestamp: Number(signal.created_at)
  }));
  const users = rows(results[usersResultIndex]).map(user => ({
    id: user.id,
    name: user.name,
    timestamp: Number(user.last_seen)
  }));
  const nextSignalId = signals.reduce((cursor, signal) => Math.max(cursor, signal.id), lastSignalId);
  const sessionActive = Number(rows(results[sessionResultIndex])[0]?.session_active) === 1;
  console.log(`Poll: room=${room}, user=${id}, signals=${signals.length}, users=${users.length}`);

  return json({
    success: true,
    signals,
    users,
    lastSignalId: nextSignalId,
    serverTime: now,
    sessionActive,
    presenceProtocol: 2
  }, 200, headers);
}

function participantCleanupStatements(room, now) {
  return [
    // Participantes que pararam de renovar viram tombstones. Assim, uma
    // requisicao atrasada da mesma geracao nao consegue ressuscita-los.
    statement(
      'UPDATE participants_v2 SET active = 0, last_seen = ? WHERE room = ? AND active = 1 AND last_seen < ?',
      [now, room, now - PARTICIPANT_TTL_MS]
    ),
    statement(
      'DELETE FROM participants_v2 WHERE room = ? AND active = 0 AND last_seen < ?',
      [room, now - PARTICIPANT_TOMBSTONE_TTL_MS]
    ),
    statement(
      'DELETE FROM participants WHERE room = ? AND last_seen < ?',
      [room, now - PARTICIPANT_TTL_MS]
    )
  ];
}

function activateParticipantStatement(room, participantId, connectionId, name, generation, now) {
  return statement(
    'INSERT INTO participants_v2 (room, participant_id, connection_id, name, generation, active, last_seen, signal_cursor) VALUES (?, ?, ?, ?, ?, 1, ?, (SELECT COALESCE(MAX(id), 0) FROM signals WHERE room = ?)) ON CONFLICT(room, participant_id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name, generation = excluded.generation, active = 1, last_seen = excluded.last_seen, signal_cursor = CASE WHEN excluded.generation > participants_v2.generation THEN excluded.signal_cursor ELSE participants_v2.signal_cursor END WHERE excluded.generation > participants_v2.generation OR (excluded.generation = participants_v2.generation AND participants_v2.active = 1 AND excluded.connection_id = participants_v2.connection_id)',
    [room, participantId, connectionId, name, generation, now, room]
  );
}

function legacyShadowCleanupStatement(
  room,
  participantId,
  connectionId,
  previousConnectionId,
  generation
) {
  return statement(
    'DELETE FROM participants WHERE room = ? AND id IN (?, ?) AND EXISTS(SELECT 1 FROM participants_v2 WHERE room = ? AND participant_id = ? AND connection_id = ? AND generation = ? AND active = 1)',
    [
      room, connectionId, previousConnectionId,
      room, participantId, connectionId, generation
    ]
  );
}

function participantListStatement(room, now) {
  return statement(
    'SELECT connection_id AS id, name, last_seen FROM participants_v2 WHERE room = ? AND active = 1 UNION ALL SELECT legacy.id AS id, legacy.name AS name, legacy.last_seen AS last_seen FROM participants legacy WHERE legacy.room = ? AND legacy.last_seen >= ? AND NOT EXISTS(SELECT 1 FROM participants_v2 migrated WHERE migrated.room = legacy.room AND migrated.connection_id = legacy.id) ORDER BY last_seen',
    [room, room, now - PARTICIPANT_TTL_MS]
  );
}

let schemaPromise;

function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = execute(env, [
      statement('CREATE TABLE IF NOT EXISTS participants (room TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (room, id))'),
      statement('CREATE TABLE IF NOT EXISTS participants_v2 (room TEXT NOT NULL, participant_id TEXT NOT NULL, connection_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', generation INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, last_seen INTEGER NOT NULL, signal_cursor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room, participant_id), UNIQUE (room, connection_id))'),
      statement('CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, sender TEXT NOT NULL, target TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)'),
      statement('CREATE INDEX IF NOT EXISTS participants_v2_active_idx ON participants_v2 (room, active, last_seen)'),
      statement('CREATE INDEX IF NOT EXISTS signals_target_idx ON signals (room, target, created_at)'),
      statement('CREATE INDEX IF NOT EXISTS signals_target_id_idx ON signals (room, target, id)')
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

function normalizeGeneration(value) {
  const generation = Number(value ?? 0);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

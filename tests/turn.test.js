import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTurnSession, verifyTurnSession, generateTurnServers, allowedTurnOrigin } from '../turn.js';
const env = { CLOUDFLARE_TURN_KEY_ID: 'test-id', CLOUDFLARE_TURN_KEY_API_TOKEN: 'provider-secret', TURN_SESSION_SECRET: 'a'.repeat(48) };
const identity = { room: 'test-room', id: 'connection', participantId: 'participant', generation: 1 };
test('signed room capabilities reject tampering, expired sessions and key rotation', async () => {
  const token = await issueTurnSession(env, identity, 100000);
  assert.deepEqual((await verifyTurnSession(env, token, 100000)).room, identity.room);
  assert.equal(await verifyTurnSession(env, token + 'x', 100000), null);
  assert.equal(await verifyTurnSession(env, token, 100000 + 8 * 3600000), null);
  assert.equal(await verifyTurnSession({ ...env, TURN_SESSION_SECRET: 'b'.repeat(48) }, token, 100000), null);
});
test('credential responses contain temporary relay credentials and never the provider key', async () => {
  const data = await generateTurnServers(env, async (_url, request) => {
    assert.equal(JSON.parse(request.body).ttl, 7200);
    return Response.json({ iceServers: [{ urls: ['turns:turn.cloudflare.com:443'], username: 'temporary-user', credential: 'temporary-password' }] });
  });
  assert(!JSON.stringify(data).includes(env.CLOUDFLARE_TURN_KEY_API_TOKEN));
  await assert.rejects(generateTurnServers(env, async () => Response.json({ iceServers: [] })));
});
test('credential endpoint origins reject unrelated websites', () => {
  assert(allowedTurnOrigin(new Request('https://worker/ice', { headers: { Origin: 'https://agoraone.vercel.app' } })));
  assert(!allowedTurnOrigin(new Request('https://worker/ice', { headers: { Origin: 'https://attacker.example' } })));
});

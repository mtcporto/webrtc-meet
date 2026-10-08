Cloudflare Realtime TURN replaces the legacy public Open Relay configuration. The Worker stores CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_KEY_API_TOKEN and TURN_SESSION_SECRET as private secrets. Never publish these in frontend code.

After joining, guests receive an HMAC-signed capability scoped to their room, participant, connection and generation. POST /ice accepts that capability only while the corresponding participant is active. Cloudflare credentials expire after two hours; the browser refreshes them before expiration. Issuance has persistent per-IP and global hourly limits and rejects unrelated browser origins. The frontend falls back to STUN if relay issuance is temporarily unavailable.

Revoke the previously published private Metered credentials in the Metered account. Changing relay providers does not revoke those historical credentials. No Metered administrator session is available in this environment.

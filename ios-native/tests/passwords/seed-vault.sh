#!/bin/bash
# Seed a THROWAWAY Walnut's vault with fake items for the iPhone Passwords E2E
# (autofill-e2e.sh). Never :3456. Serve site/ on 127.0.0.1:8765 beside it:
#   (cd site && python3 -m http.server 8765 --bind 127.0.0.1)
# It prints the vault's Secret Key, and the public key of the localhost passkey for
# WALNUT_E2E_PASSKEY_PK, which lets site/passkey.html check the signature it gets.
set -euo pipefail
PORT=${1:?port}
[ "$PORT" != 3456 ] || { echo "refusing production"; exit 1; }
B=http://127.0.0.1:$PORT/api/v1
MASTER='Walnut demo master 2026'
SALT=$(python3 -c 'import os,base64;print(base64.b64encode(os.urandom(16)).decode())')
SETUP=$(curl -sf -X POST $B/vault/setup -H 'content-type: application/json' -d "{\"password\":\"$MASTER\",\"kdf\":{\"name\":\"PBKDF2-SHA256\",\"iterations\":650000,\"salt\":\"$SALT\"},\"agentsWhileAway\":false,\"client\":\"seed\"}")
SESSION=$(echo "$SETUP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["token"])')
echo "$SETUP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("secretKey",d["secretKey"])'
add() { curl -sf -X POST $B/vault/items -H 'content-type: application/json' -H "x-walnut-vault-session: $SESSION" -d "{\"item\":$1}" >/dev/null; }
add '{"type":"login","title":"GitHub","username":"walnut-demo@example.test","password":"Fake-GitHub-Pass-71!","urls":["github.com"],"totp":"otpauth://totp/GitHub:walnut-demo?secret=JBSWY3DPEHPK3PXP&issuer=GitHub","favorite":true}'
add '{"type":"login","title":"GitHub (work)","username":"demo-work@example.test","password":"Fake-Work-Pass-22!","urls":["github.com"]}'
add '{"type":"login","title":"Example Bank","username":"jordan.lee","password":"Fake-Bank-Pass-9!","urls":["bank.example.test"],"totp":"KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU"}'
add '{"type":"login","title":"Fastmail","username":"jordan@example.test","password":"Fake-Mail-Pass-3!","urls":["fastmail.com"],"favorite":true}'
add '{"type":"login","title":"Notion","username":"jordan@example.test","password":"Fake-Notion-Pass-5!","urls":["notion.so"]}'
add '{"type":"login","title":"Cloudflare","username":"jordan-admin@example.test","password":"Fake-Cf-Pass-8!","urls":["dash.cloudflare.com"],"totp":"MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U"}'
add '{"type":"login","title":"Local test site","username":"tester@example.test","password":"Fake-Local-Pass-1!","urls":["http://localhost:8765"],"totp":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}'
add '{"type":"login","title":"Café Wi-Fi","username":"guest","password":"Fake-Wifi-été-4","urls":["router.example.test"],"notes":"Second floor, near the window 🌰"}'
add '{"type":"note","title":"Apartment door code","notes":"Front door: 4821#\nMailbox: 17"}'
add '{"type":"card","title":"Visa (test card)","card":{"holder":"Jordan Lee","number":"4242424242424242","expMonth":"08","expYear":"2029","code":"123","brand":"Visa"}}'
add '{"type":"api_key","title":"OpenAI test key","envName":"OPENAI_API_KEY","password":"sk-test-not-a-real-key-000000"}'
# A passkey for webauthn.io, made by the server as an authenticator would (fake client data).
CD=$(python3 -c 'import json,base64;print(base64.urlsafe_b64encode(json.dumps({"type":"webauthn.create","challenge":"ZmFrZS1jaGFsbGVuZ2U","origin":"https://webauthn.io"}).encode()).decode().rstrip("="))')
curl -sf -X POST $B/vault/passkeys/create -H 'content-type: application/json' -H "x-walnut-vault-session: $SESSION" -d "{\"origin\":\"https://webauthn.io\",\"rpId\":\"webauthn.io\",\"rpName\":\"WebAuthn.io\",\"user\":{\"id\":\"ZGVtby11c2Vy\",\"name\":\"walnut-demo\",\"displayName\":\"Walnut Demo\"},\"clientDataJSON\":\"$CD\"}" >/dev/null && echo passkey ok || echo passkey failed
# A passkey for the local test site (rpId localhost) on its login, for flow 07-passkey.
LOCAL_ID=$(curl -sf $B/vault/items -H "x-walnut-vault-session: $SESSION" | python3 -c 'import json,sys;print([i["id"] for i in json.load(sys.stdin)["items"] if i.get("title")=="Local test site"][0])')
CD=$(python3 -c 'import json,base64;print(base64.urlsafe_b64encode(json.dumps({"type":"webauthn.create","challenge":"ZmFrZS1jaGFsbGVuZ2U","origin":"http://localhost:8765"}).encode()).decode().rstrip("="))')
curl -sf -X POST $B/vault/passkeys/create -H 'content-type: application/json' -H "x-walnut-vault-session: $SESSION" -d "{\"origin\":\"http://localhost:8765\",\"rpId\":\"localhost\",\"rpName\":\"Acme\",\"itemId\":\"$LOCAL_ID\",\"user\":{\"id\":\"dGVzdGVyQGV4YW1wbGUudGVzdA\",\"name\":\"tester@example.test\",\"displayName\":\"Tester\"},\"clientDataJSON\":\"$CD\"}" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("WALNUT_E2E_PASSKEY_PK", (d.get("passkey") or d).get("publicKey") or d.get("publicKey"))' || echo "localhost passkey failed"
curl -sf $B/vault/items -H "x-walnut-vault-session: $SESSION" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["items"]),"items")'
curl -sf -X POST $B/vault/lock -H 'content-type: application/json' -H "x-walnut-vault-session: $SESSION" -d '{}' >/dev/null
echo "master: $MASTER"

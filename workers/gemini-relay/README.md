# pixel-gemini-relay — Gemini pass-through relay (test transport)

Minimal Worker on the **backup** Cloudflare account. It exists because the
direct fetch from `pixel-preview` to `generativelanguage.googleapis.com`
fails instantly at transport level (live-verified 2026-11-22: all three
allowlist models, `transient_failure` in 0 ms, twice — no HTTP response
ever arrives, so the key was never validated). The owner ordered a relay /
proxy when direct fails.

## What it does

- Accepts `POST /v1beta/models/<model>:generateContent` only (any other
  method/path → 404, no query forwarded).
- Forwards the request to Google's official origin with the same body and
  the `x-goog-api-key` header it received, and returns Google's response
  verbatim (status + body; only `content-type` and `retry-after` headers).
- The API key is **never stored** here: it transits in the header from
  `pixel-preview` (which holds the secret) to Google. Nothing is logged.

## Deploy (backup account)

```sh
python3 /tmp/cf_run_backup.py npx wrangler deploy --config workers/gemini-relay/wrangler.jsonc
```

## Use from pixel-preview

Set the `GEMINI_API_BASE_URL` var override to the deployed relay URL
(e.g. `https://pixel-gemini-relay.<account-subdomain>.workers.dev`).
The adapter validates it (https-only) and keeps sending the key only in
the `x-goog-api-key` header.

## Hardening before production use

Require a relay shared-secret header from `pixel-preview` so this
endpoint is not a public pass-through for arbitrary callers' keys.
Until then this relay is a test-only transport and `AI_GEMINI_ENABLED`
stays operator-gated.

# Remove the ngrok share tunnel from the CLI

`dobby dev` used to pass `--ngrok` to `portless run` by default (opt-out via `--no-share`), exposing the app on a public ngrok URL that `dobby env` reported as `shareUrl`. Removed entirely: the preflight (`ngrok version`) only proved the binary existed, while an ngrok that was present but unauthenticated or free-tier-limited made bundled portless kill the whole dev server (`process.exit(1)`) with `up` then blaming the portless daemon / CA trust; and the URL rotated every session with no way to pin it — portless 0.15.3 hardcodes ngrok's args (no `--url`/`--domain` pass-through), so a persistent subdomain was impossible without dobby spawning ngrok itself. No plugin skill ever consumed `shareUrl` (the kit drives the app via the local `devUrl`), so share was pure downside: a default-on feature whose failure mode was fatal to the thing that mattered.

## Considered options

- **Persistent ngrok domain** — requires dobby to own the ngrok process (portless can't pass the flag through) plus a reserved-domain tier; rejected as scope the kit doesn't need while nothing consumes the URL.
- **portless `--tailscale` / `--funnel`** — per-machine-stable URLs, same fatal failure shape; unevaluated, noted as the same-cost lever if sharing returns.
- **Keep + degrade gracefully** — would need a usability (not presence) preflight and portless to stop exiting fatally; the fix belongs upstream.

## Consequences

A future re-add should start from a persistent domain (dobby-spawned ngrok or an upstream portless pass-through) and a non-fatal failure mode — never a random per-session URL wired to `process.exit(1)`. The removal rationale also lives in `cli/CONTEXT.md` ("What's intentionally NOT here").

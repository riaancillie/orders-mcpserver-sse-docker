# food-orders-mcp

A small **Model Context Protocol (MCP) server** written in TypeScript. It exposes a
fixed set of fake food-delivery orders so an AI client can list and inspect them,
and it exists to show what a minimal MCP server looks like: one source file, two
read-only tools, no database, no authentication.

It is packaged as a **Docker image and intended to run on Azure Container Apps**
(consumption plan, scale-to-zero). Container Apps provides the public HTTPS
endpoint and TLS, so ChatGPT, Gemini, and any other client that speaks
**Streamable HTTP** can add it as a custom connector. The container listens on
port 3000 and serves exactly two routes:

| Endpoint       | Purpose                               |
| -------------- | ------------------------------------- |
| `POST /mcp`    | MCP JSON-RPC endpoint (SSE responses) |
| `GET /healthz` | Health / liveness probe               |

| Tool        | Input                | Returns                                                       |
| ----------- | -------------------- | ------------------------------------------------------------- |
| `getOrders` | —                    | Summary list of 5 mock food-delivery orders (`id`, `orderNumber`, `restaurant`, `status`, `itemCount`, `total`, timestamps) |
| `getOrder`  | `{ orderId: uuid }`  | Full order: customer + address, line items with `lineTotal`, subtotal/delivery fee/tax/tip/total, courier, status history |

Everything is mock data; nothing here touches a real store, courier, or payment
system.

`orderId` values are fixed UUIDs (v4), so the IDs returned by `getOrders` work
in `getOrder` forever. Unknown-but-valid UUIDs return `isError: true` plus the
list of known IDs; malformed UUIDs are rejected by input validation.

## Run locally

```bash
npm install
npm run dev        # tsx watch, http://localhost:3000/mcp
# or
npm run build && npm start   # compiled dist/server.js, same URL
```

`GET /mcp` and `DELETE /mcp` return `405` — stateless mode offers no
server→client SSE stream and no session teardown.

## Run as a container

The Docker image is the deployment artifact and is what runs on Azure Container
Apps:

```bash
docker build -t food-orders-mcp .
docker run --rm -p 3000:3000 -e PORT=3000 food-orders-mcp
curl http://localhost:3000/healthz
# or: npm run docker:build && npm run docker:run
```

The image listens on `0.0.0.0:3000`, runs as the non-root `node` user, and
declares a `HEALTHCHECK` against `/healthz`. On Container Apps, point ingress at
container port `3000` and configure a startup/liveness probe on `/healthz` —
Container Apps runs its own probes and ignores the image-level `HEALTHCHECK`.

## Deploy to Azure Container Apps (Bicep)

`main.bicep` creates everything the app needs inside one resource group:

| Resource | Purpose |
| -------- | ------- |
| Log Analytics workspace | Container logs (first 5 GB/month of ingestion is free) |
| Container Apps environment | Consumption-plan host for the app |
| Container app | External HTTPS ingress on port 3000, 0.25 vCPU / 0.5 GiB, scale 0→2, startup/liveness/readiness probes on `/healthz` |

Prerequisites: Azure CLI with Bicep (`az bicep version`), and the image pushed to
a **public** registry (GHCR steps above). The image must be `linux/amd64`.

```powershell
# 1. resource group (any region; westeurope used here)
az group create -n rg-food-orders -l westeurope

# 2. optional: preview what would change
az deployment group create -g rg-food-orders -n food-orders -f main.bicep `
  -p image=ghcr.io/<owner>/food-orders-mcp:0.1.0 --what-if

# 3. deploy
az deployment group create -g rg-food-orders -n food-orders -f main.bicep `
  -p image=ghcr.io/<owner>/food-orders-mcp:0.1.0

# 4. read back the connector URL
az deployment group show -g rg-food-orders -n food-orders `
  --query properties.outputs.mcpEndpoint.value -o tsv
```

`image` is the only required parameter. The rest:

| Parameter | Default | Notes |
| --------- | ------- | ----- |
| `location` | resource group's location | |
| `namePrefix` | `food-orders` | Prefix for generated resource names |
| `mcpAuthToken` | empty | Empty = `/mcp` is open; set it to require `Authorization: Bearer <token>` |
| `minReplicas` | `0` | `1` keeps a warm replica (~$4/month) and avoids cold starts |
| `maxReplicas` | `2` | Caps the cost blast radius of a public endpoint |
| `concurrentRequests` | `10` | HTTP scale-out threshold per replica |
| `logRetentionInDays` | `30` | |

Deploy with a token instead of an open endpoint:

```powershell
az deployment group create -g rg-food-orders -n food-orders -f main.bicep `
  -p image=ghcr.io/<owner>/food-orders-mcp:0.1.0 mcpAuthToken='<random-secret>'
```

Validate template changes without deploying:

```powershell
az bicep build --file main.bicep --stdout > $null
```

After the deployment:

```powershell
# replica/scale settings on the running app
az containerapp show -n <containerAppName> -g rg-food-orders `
  --query properties.template.scale -o json

# live logs
az containerapp logs show -n <containerAppName> -g rg-food-orders --follow
```

Then add `https://<fqdn>/mcp` as the connector URL in ChatGPT / Gemini — auth
**No authentication** when `mcpAuthToken` is empty, or **API key** with the token
when it is set.

Tear it all down (resource group only contains this demo):

```powershell
az group delete -n rg-food-orders --yes --no-wait
```

Notes:

- Container Apps serves the default `*.azurecontainerapps.io` hostname with a
  trusted TLS certificate, which is enough for the connectors — no custom domain.
- With `minReplicas: 0` the app scales to zero after ~5 minutes of no traffic;
  the first request afterwards takes a few seconds to cold start.
- The template does not configure registry credentials. Publish the image
  publicly, or add `configuration.registries` to the container app for a private
  registry.
- Idle replicas are billed at the reduced idle rate; scale-to-zero costs nothing.
  The consumption plan includes 180,000 vCPU-seconds, 360,000 GiB-seconds and
  2 million requests per subscription per month.

## Configuration

| Env var          | Default   | Meaning                                                    |
| ---------------- | --------- | ---------------------------------------------------------- |
| `PORT`           | `3000`    | Listen port                                                |
| `HOST`           | `0.0.0.0` | Listen address                                             |
| `MCP_AUTH_TOKEN` | unset     | When set, `/mcp` requires `Authorization: Bearer <token>`  |

With `MCP_AUTH_TOKEN` set, use the connector's **API key** auth and paste the
token. With it unset, use **No authentication**. `/healthz` never requires auth.

## Expose it to ChatGPT / Gemini

Both services call your server from their cloud, so `localhost` will not work.
In production, use the Container Apps ingress URL
(`https://<app-name>.<region>.azurecontainerapps.io/mcp`). For local development,
open a tunnel while you test:

```bash
cloudflared tunnel --url http://localhost:3000
# or
ngrok http 3000
```

Then paste `https://<your-tunnel-host>/mcp` as the connector URL:

- **ChatGPT**: Settings → Connectors → Advanced/Developer mode → Create →
  URL above, auth = No authentication (or API key = `MCP_AUTH_TOKEN`). Refresh
  the connector after changing a tool's schema — ChatGPT caches the tool list.
- **Gemini**: add a custom MCP connector with the same URL where your Gemini
  surface supports remote MCP servers (Gemini CLI uses
  `gemini mcp add --transport http food-orders https://<host>/mcp`).
- **Inspector**: `npm run inspect`, transport = Streamable HTTP, URL
  `http://localhost:3000/mcp`.

If port 3000 is already in use on your machine, pick another: PowerShell
`$env:PORT=3010; npm start`, bash `PORT=3010 npm start`.

## Smoke test

```bash
curl -s http://localhost:3000/healthz

curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"getOrder",
                 "arguments":{"orderId":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}}}'
```

Replies arrive as `event: message` / `data: {...}` SSE frames.

## Notes

- Stateless: a fresh `McpServer` + transport is created per POST, so there is
  no `Mcp-Session-Id` to manage and multiple clients can share the endpoint.
- No JSON body parser is mounted on `/mcp` on purpose — the transport reads the
  raw request stream itself.
- Tool results are plain `text` content (pretty-printed JSON) rather than
  `structuredContent`, because zod-generated output schemas use `$defs`, which
  ChatGPT handles poorly.
- `npm run typecheck` runs `tsc --noEmit`; `erasableSyntaxOnly` is on, so
  `node --experimental-strip-types server.ts` also works on Node 22.13+.

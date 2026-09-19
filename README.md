# imgproxy

A local image-generation proxy with a web UI. Exposes OpenAI- and A1111-compatible image
APIs on your machine and forwards requests to a configurable backend — a ComfyUI instance
(with a custom workflow + input-to-node mapping), an OpenAI-compatible endpoint, or an
A1111-compatible endpoint.

## Features

- Single local server (default `127.0.0.1:7800`) hosting:
  - **Web UI** at `/` — configure providers, test generations, browse/delete history
  - **OpenAI-compatible API** — `POST /v1/images/generations`
  - **A1111-compatible API** — `POST /sdapi/v1/txt2img` plus stub endpoints
    (`/sdapi/v1/options`, `sd-models`, `samplers`, `progress`, …) so standard clients connect cleanly. 
- **ComfyUI backend**: paste or upload an API-format workflow, then map public parameters
  (prompt, width, height, seed, steps, cfg, …) onto specific node inputs.
- **History**: every request and generated image is recorded locally, viewable in
  the UI; individual entries or the whole history can be deleted.

## Important!

This proxy is intended for use on your local network only. There is no authentication
or access control. It is not recommended to expose this proxy to the public internet.

## Getting started

```bash
npm install
npm run dev        # server (tsx watch) + web UI (vite) at http://127.0.0.1:5173
```

Production:

```bash
npm run build
npm start          # serves API + built web UI from http://127.0.0.1:7800
```

Tests: `npm test` · Typecheck: `npm run typecheck`

## Configuration

Everything is configured in the web UI (**Settings** tab) and stored in `data/config.json`.

### ComfyUI provider setup

1. Launch **ComfyUI** with `--enable-cors-header "*"` to enable API access.
1. Add a **ComfyUI** provider, set its base URL (e.g. `http://127.0.0.1:8188`).
2. Export your workflow from ComfyUI (File → Export (API) → Enter a file name → Confirm)
   Use "Upload workflow file..." or paste the text into the "Workflow JSON" field.
3. In **Input-to-node mapping**, pick the node + input that should receive each parameter.
4. Optionally set defaults (used when a request omits the value). Requests with a missing/`-1`
   seed get a random seed; the seed actually used is recorded in history.
5. Mark the provider **active** and hit **Check** to verify connectivity.

When more than one image (`n > 1`) is requested: if `batch_size` is mapped, it is forwarded and
a single run produces all images; otherwise the workflow runs `n` times with incremented seeds.

## API examples

OpenAI-compatible:

```bash
curl http://127.0.0.1:7800/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"prompt":"a cat astronaut","n":1,"size":"1024x1024","response_format":"b64_json"}'
```

A1111-compatible:

```bash
curl http://127.0.0.1:7800/sdapi/v1/txt2img \
  -H 'content-type: application/json' \
  -d '{"prompt":"a cat astronaut","steps":8,"width":1024,"height":1024,"seed":-1}'
```

## Layout

```
src/
  config/     zod-validated config + persistence (data/config.json)
  core/       normalized request types, provider registry, generation pipeline
  providers/  comfyui (workflow + mapping), openai, a1111
  api/        public routes (OpenAI, A1111) + /api/* routes for the web UI
  history/    SQLite (better-sqlite3) + image file storage
client/       React + Vite web UI (Test, History, Settings)
data/         runtime state (gitignored)
workflows/    sample ComfyUI API-format workflows
```

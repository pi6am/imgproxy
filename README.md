# imgproxy

A local image-generation proxy with a web UI. Exposes OpenAI- and A1111-compatible image
APIs on your machine and forwards requests to a configurable backend — a ComfyUI instance
(with a custom workflow + input-to-node mapping), an OpenAI-compatible endpoint, or an
A1111-compatible endpoint. New backend types (e.g. FAL.ai) can be added as additional providers.

## Features

- Single local server (default `127.0.0.1:7800`) hosting:
  - **Web UI** at `/` — configure providers, test generations, browse/delete history
  - **OpenAI-compatible API** — `POST /v1/images/generations` (supports `url` and `b64_json` response formats; `gpt-image-*` models default to `b64_json`, matching OpenAI). Optional bearer-token protection.
  - **A1111-compatible API** — `POST /sdapi/v1/txt2img` plus stub endpoints (`/sdapi/v1/options`, `sd-models`, `samplers`, `progress`, …) so standard clients connect cleanly. Enable/disable only (the A1111 ecosystem has no bearer auth — A1111/Forge use HTTP Basic via `--api-auth`, and clients like KoboldAI Lite send no credentials).
  - ComfyUI backends can require a token: set the provider's optional **bearer token** and imgproxy will authenticate every request it makes to ComfyUI.
- **ComfyUI backend**: paste or upload an API-format workflow, then map public parameters
  (prompt, width, height, seed, steps, cfg, …) onto specific node inputs. Unmapped parameters
  are simply not forwarded. The provider submits via `/prompt`, polls `/history`, and downloads
  results from `/view`.
- **History**: every request and generated image is recorded locally (SQLite + files on disk),
  viewable in the UI; individual entries or the whole history can be deleted.

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
API keys are stored in plaintext — this is a local tool; don't point it at a shared filesystem.

### ComfyUI provider setup

1. Add a **ComfyUI** provider, set its base URL (e.g. `http://127.0.0.1:8188`).
2. Paste your workflow's **API-format JSON** (ComfyUI → enable developer mode → "Save (API Format)"),
   or upload a `.json` file. Sample workflows live in `workflows/`.
3. In **Input-to-node mapping**, pick the node + input that should receive each parameter.
   For example, for `workflows/image_krea2_turbo_t2i.json`:
   - `prompt` → node `30:19`, input `value`
   - `width` → node `52`, input `value` (a `PrimitiveInt` node) — or node `30:5`, input `width` directly
   - `height` → node `53`, input `value`
   - `seed` → node `55`, input `value`
   - `steps`/`cfg` → node `30:3`, inputs `steps`/`cfg`
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

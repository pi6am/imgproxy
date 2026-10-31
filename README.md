# imgproxy

A local image-generation proxy with a web UI. Exposes OpenAI-, A1111- and sd-cpp-compatible image
APIs on your machine and forwards requests to a configurable backend — a ComfyUI instance
(with a custom workflow + input-to-node mapping), an OpenAI-compatible endpoint, an
A1111-compatible endpoint, or a [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
server (`sd-server`) via its native async job API.

## Features

- Single local server (default `127.0.0.1:7800`) hosting:
  - **Web UI** at `/` — configure providers, test generations, browse/delete history
  - **OpenAI-compatible API** — `POST /v1/images/generations`
  - **A1111-compatible API** — `POST /sdapi/v1/txt2img` plus stub endpoints
    (`/sdapi/v1/options`, `sd-models`, `samplers`, `progress`, …) so clients connect cleanly. 
  - **sd-cpp-compatible API** — `POST /sdcpp/v1/img_gen` (async jobs) plus
    `capabilities`, `model-files`/`models/*` and job polling, so sd-cpp clients and
    launchers can drive imgproxy like an sd-server.
- **ComfyUI backend**: paste or upload an API-format workflow, then map public parameters
  (prompt, width, height, seed, steps, cfg, …) onto specific node inputs.
- **sd-cpp backend** ([stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) server):
  submits async jobs to the native `/sdcpp/v1/img_gen` API and polls them to completion.
  Dimensions, steps, CFG, sampler/scheduler, seed and `n` → `batch_count` are forwarded;
  anything the request omits falls back to the server's recipe defaults.
- **History**: Generated images can optionally be saved locally and viewed in
  the History tab.

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

### sd-cpp (stable-diffusion.cpp) provider setup

1. Start the server from the stable-diffusion.cpp repo (`examples/server`, default port 8080)
   with your model directories, and load a model — either via its own web UI or
   `POST /sdcpp/v1/models/load`.
2. Add an **sd-cpp** provider and set its base URL (e.g. `http://127.0.0.1:8080`).
3. Mark the provider **active** and hit **Check** — it reports the model loaded on the server.

Each request is submitted as an async job (`POST /sdcpp/v1/img_gen`) and polled
(`GET /sdcpp/v1/jobs/{id}`) until it completes, fails, is cancelled or times out.
A1111-style sampler/scheduler names (`Euler a`, `DPM++ 2M`, `Karras`, …) are translated to
sd-cpp ids automatically; unset parameters are left off the request so the server's recipe
defaults apply.

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

sd-cpp-compatible (async job model):

```bash
curl http://127.0.0.1:7800/sdcpp/v1/img_gen \
  -H 'content-type: application/json' \
  -d '{"prompt":"a cat astronaut","width":1024,"height":1024,"sample_params":{"sample_method":"euler_a","sample_steps":20}}'
# → 202 { "id": "job_…", "poll_url": "/sdcpp/v1/jobs/job_…" }
curl http://127.0.0.1:7800/sdcpp/v1/jobs/job_…   # poll until status == "completed"
```

### sd-cpp-compatible API details

`GET /sdcpp/v1/capabilities` answers locally (it's the launcher health check), advertising
the samplers/schedulers imgproxy understands. The model-management endpoints are translated
per active backend:

| Endpoint | sd-cpp backend | A1111 backend | ComfyUI / OpenAI backends |
| --- | --- | --- | --- |
| `GET /sdcpp/v1/model-files` | forwarded | upstream `sd-models` | only the workflow's mapped model / the configured model |
| `GET /sdcpp/v1/models/status` | forwarded | upstream `options` | `ready` with the fixed model |
| `POST /sdcpp/v1/models/load` | forwarded (blocks) | switches checkpoint via `options` | succeeds for the fixed model, fails for others |

Jobs are held in memory: completed jobs and their images are kept for the process lifetime
(bounded), a restart or eviction answers `404`/`410` ("job gone") just like an sd-server.
Cancellation reports `cancel_requested: false` — providers cannot be interrupted mid-run.
LoRA overrides are applied natively when the backend is sd-cpp itself and ignored elsewhere;
`GET /sdapi/v1/loras` serves the backend's real list when it has one.

## Layout

```
src/
  config/     zod-validated config + persistence (data/config.json)
  core/       normalized request types, provider registry, generation pipeline
  providers/  comfyui (workflow + mapping), openai, a1111, sdcpp
  api/        public routes (OpenAI, A1111, sd-cpp) + /api/* routes for the web UI
  history/    SQLite (better-sqlite3) + image file storage
client/       React + Vite web UI (Test, History, Settings)
data/         runtime state (gitignored)
workflows/    sample ComfyUI API-format workflows
```

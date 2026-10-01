# Models: one key, a local server, or both

Three stages decide what the edit says, and each needs a model for standard
quality: **description** (looking at an event's frames), **judgement** (what the
event is worth to the piece) and **search** (text embeddings). All three speak
the OpenAI chat-completions and embeddings shapes, so any provider or local
server that does is the same configuration. Transcription, on-screen text and
picture features run on this machine in the Python worker, with no key at all.

`oea doctor` says what is configured, what each stage will use, and whether a
key works.

## One Gemini key

Copy `.env.example` to `.env` in the directory you run `oea` from (the
repository root for `pnpm oea`) and paste the key:

```bash
OEA_GEMINI_API_KEY=…
```

In a hosted environment, set that one variable in its settings instead. The key
comes from [Google AI Studio](https://aistudio.google.com/apikey).

That line fills every stage through Gemini's OpenAI-compatible endpoint
(`https://generativelanguage.googleapis.com/v1beta/openai`):

| stage                    | variable it fills          | default model           | why this one                                          |
| ------------------------ | -------------------------- | ----------------------- | ----------------------------------------------------- |
| description, `oea agent` | `OEA_VLM_*`, `OEA_AGENT_*` | `gemini-3.8-flash`      | sees frames, writes the transcript's language         |
| judgement                | `OEA_DECISION_*`           | `gemini-3.5-flash-lite` | called for every event, with ~1,560 input tokens each |
| search                   | `OEA_EMBED_*`              | `gemini-embedding-001`  | multilingual; `夜景` finds "night view of the city"   |

It also sets `OEA_VLM_SCOPE=base` (describe every event, not only the ones that
earn a closer look — without it a hosted-only setup cannot reach standard
quality) and `OEA_DECISION=local-system-one` (the model judges, the rules are
the fallback).

- **Only what is not set.** A stage whose own `…_BASE_URL` is already set keeps
  all of its settings, and this key is never sent to that URL. A local vision
  model beside Gemini judgement is `OEA_VLM_BASE_URL` plus this key.
- **Only when asked.** A `GEMINI_API_KEY` that other tools put in your shell does
  nothing by itself; set `OEA_PROVIDER=gemini` to use it. Turning the preset on
  sends frames to Google, and nothing here does that uninvited.
- **Model names move.** Before a command that calls a model, `oea` asks Gemini
  which models the key can use (one request). A default the list lacks is
  replaced by the newest plain release of the same family — never a `-preview`,
  `-exp` or `-image` variant — and the replacement is said. A model you name is
  never replaced. Pin your own with `OEA_GEMINI_MODEL`,
  `OEA_GEMINI_JUDGE_MODEL` and `OEA_GEMINI_EMBED_MODEL`.
- **A refused key stops the command** before any analysis, with Google's own
  message, rather than failing once per event.

### What it costs, and how to bound it

Every event is described and judged once, and cached: a re-analysis, another
skill or another duration costs nothing again. Still, silent footage is described
and judged by rules instead ([the mask](cost.md)), and video frames are sent at
768 pixels on the long edge (a photograph is sent as the file is). An event with
nothing to look at and nothing said — a sound file nobody transcribed — is
described by rules too: a model would only invent it.

Measured with a real key on the five probe stills: description 9,496 input and
644 output tokens (about 1,900 in per event with its picture), judgement 7,418
in and 1,180 out (about 1,480 per event), and one embedding call.

`--budget <usd>` refuses to spend past a limit. It prices descriptions at a
fixed estimate per event and does not price judgement, so treat it as a guard on
the larger of the two rather than as a bill; a spending cap in the Google
console is the hard one. `oea analyze` reports what it estimated and what the
mask saved.

### What leaves the machine

Frames of each described event, the transcript's words, and the text of events
for search go to Google. The video file, the audio and everything else stay
here. Every analysis says `media left this machine: yes` when this is on
([privacy](privacy.md)).

## Everything on this machine

No key, no cost, nothing sent anywhere. A local server that speaks the OpenAI
shape serves description and judgement; the Python worker serves the rest.

```bash
# the worker: transcription, on-screen text, picture features, text embeddings
python3 -m venv .venv && . .venv/bin/activate
pip install -e 'services/perception[all]'
export OEA_PERCEPTION=python
export OEA_ASR_MODEL=small                            # base by default; small or larger for Japanese
export OEA_TEXT_MODEL=intfloat/multilingual-e5-small  # search by meaning

# a local server for description and judgement (Ollama shown; vLLM, LM Studio
# and llama.cpp work the same way)
ollama pull qwen2.5vl:7b && ollama pull qwen3:8b
export OEA_VLM_BASE_URL=http://localhost:11434/v1 OEA_VLM_MODEL=qwen2.5vl:7b
export OEA_DECISION=local-system-one
export OEA_DECISION_BASE_URL=http://localhost:11434/v1 OEA_DECISION_MODEL=qwen3:8b
```

The model names are examples; any vision model and any instruction model the
server offers will do. A model on `localhost` describes every event, because
that is free. Sixteen gigabytes of memory is a comfortable floor, and a GPU
makes transcription and description several times faster.

## Transcription from a server (Phonon-2 and others)

Transcription runs in the Python worker's Whisper by default. A server speaking
OpenAI's `POST /v1/audio/transcriptions` can do it instead, with or without the
worker:

```bash
OEA_TRANSCRIBE_BASE_URL=http://localhost:8010/v1
OEA_TRANSCRIBE_MODEL=phonon-2
# OEA_TRANSCRIBE_API_KEY=…      a hosted server's key
# OEA_TRANSCRIBE_LANGUAGES=en   which languages it can transcribe (default: any)
```

**Phonon-2** ([Fermion Research](https://www.fermionresearch.com/models/phonon-2/),
CC-BY-4.0 weights) is a 164 MB English model that is very fast on a CPU. Run it
with `pip install fermion-research`, then `phonon serve --port 8010`. Measured
here: an English clip transcribed correctly in 0.24 s of decoding on four CPU
cores, through the same request this client sends. The first run downloads the
model and compiles its runtime, which takes about a minute.

- **English only.** A model name containing `phonon` is taken as English-only
  without being told. A project whose language (`editing_goal.language` in
  context.yaml) is English goes to the server. Anything else goes to the
  worker's Whisper when it is installed, and otherwise fails with a message
  saying so. An unset language is not guessed to be English, because a
  wrong-language transcript is worse than none. To use Phonon-2, set
  `language: en`.
- **No word times.** Phonon-2 returns one start and end per request. The client
  learns this from the first answer and from then on sends the audio one stretch
  of speech at a time, split where it is quiet for two seconds or more, so a
  pause still ends an utterance. Measured on a clip with a four-second pause: one
  utterance from 0 to 13.7 s became two, 0–3.65 s and 7.05–13.74 s. A server that
  does return word times (a Whisper server, OpenAI's `whisper-1`) is sent each
  file whole and split at its own word gaps.
- **Hosted limits.** A file over 24 MB (about twelve minutes of prepare's 16 kHz
  WAV) is sent in pieces, cut at the quietest moment near each limit, with the
  times put back on the file's clock.
- A server that answers only text is asked that way once it refuses
  `verbose_json`, and its text is placed over the stretch it came from at low
  confidence.

## Both

The variables are per stage, so any mix works: transcription in the worker,
descriptions from a local vision model, judgement and search from Gemini.

```bash
OEA_GEMINI_API_KEY=…
OEA_PERCEPTION=python
OEA_VLM_BASE_URL=http://localhost:11434/v1
OEA_VLM_MODEL=qwen2.5vl:7b
```

Here the frames never leave the machine; only the text of each event does.

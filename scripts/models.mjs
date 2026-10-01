#!/usr/bin/env node
/**
 * Fetching the weights, with a checksum for every byte.
 *
 *   node scripts/models.mjs list
 *   node scripts/models.mjs get clip-vit-b32
 *   node scripts/models.mjs get e5-large --to /srv/models
 *   node scripts/models.mjs check
 *
 * ## Why this is a script and not a paragraph in the README
 *
 * Every model here was found by trying. The instruction "download it from the
 * hub" is not a provisioning story on a machine where the hub is blocked by
 * policy — which is normal inside companies and is where this project was
 * built — and "some file called model.onnx" is not an identity. So each entry
 * carries a URL that was fetched, a sha256 that was computed from what came
 * back, a byte count, and the licence, and a mismatch deletes the download
 * rather than leaving something plausible on disk.
 *
 * The digests are the point. A model is the thing that decides every vector the
 * project produces, its name goes into the cache key and into the provenance
 * record of a document meant to be shared, and "multilingual-e5-large" names a
 * dozen different exports with different numerics. Only the hash says which one
 * ran.
 *
 * ## What is deliberately not here
 *
 * The CTranslate2 Whisper weights that `backends/asr.py` loads. There is no
 * reachable URL for them that does not go through huggingface.co: the mirrors
 * (hf-mirror.com, modelscope.cn) are blocked at the same layer, no PyPI package
 * ships them — the whole 46 MB simple index was searched — and converting them
 * locally needs torch and transformers, which this project deliberately does not
 * install. `describe` under `transcribe` says so plainly rather than pretending
 * there is a command for it.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Where weights go when nobody says otherwise.
 *
 * Not inside the repository: they are hundreds of megabytes, they are shared
 * between projects, and a `models/` directory in a checkout is one `git add -A`
 * away from an unpleasant afternoon.
 */
export const DEFAULT_ROOT =
  process.env.OEA_MODEL_DIR ??
  join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'editorial-ir', 'models');

/**
 * Everything this project can load, and how to get it.
 *
 * `files` are downloaded as-is. `archive` is downloaded, checked, unpacked, and
 * its `contains` entries are checked again — because a tarball's digest tells
 * you the transfer was clean and says nothing about what a future re-upload of
 * the same URL might contain.
 */
export const MODELS = [
  {
    id: 'clip-vit-b32',
    stage: 'embed_frames',
    env: 'OEA_VISUAL_MODEL',
    title: 'CLIP ViT-B/32, ONNX (both towers)',
    licence: 'MIT (OpenAI CLIP)',
    bytes: 607_000_000,
    notes:
      'The only visual model here that needs neither torch nor a model hub. ' +
      'Its text tower is English-only: a Japanese query against it ranks noise, ' +
      'and the worker reports that rather than answering.',
    files: [
      {
        name: 'visual.onnx',
        url: 'https://clip-as-service.s3.us-east-2.amazonaws.com/models/onnx/ViT-B-32/visual.onnx',
        sha256: '78e896b2c7301d01eda84e280d7c7297299aa6f8bacc0f5f8fe5bd60d42d8aae',
        bytes: 351_519_609,
      },
      {
        name: 'textual.onnx',
        url: 'https://clip-as-service.s3.us-east-2.amazonaws.com/models/onnx/ViT-B-32/textual.onnx',
        sha256: '55c85d8cbb096023781c1d13c557eb95d26034c111bd001b7360fdb7399eec68',
        bytes: 254_120_034,
      },
      {
        // The merge table, from OpenAI's own repository. It is the tokeniser
        // rather than a weight, and the tests hash it: a different merge table
        // silently produces different tokens for everything.
        name: 'bpe_simple_vocab_16e6.txt.gz',
        url: 'https://raw.githubusercontent.com/openai/CLIP/main/clip/bpe_simple_vocab_16e6.txt.gz',
        sha256: '924691ac288e54409236115652ad4aa250f48203de50a9e4722a6ecd48d6804a',
        bytes: 1_356_917,
      },
    ],
  },
  {
    id: 'e5-large',
    stage: 'embed_text',
    env: 'OEA_TEXT_MODEL',
    title: 'multilingual-e5-large, ONNX fp32',
    licence: 'MIT (model); repackaged by Qdrant fastembed',
    bytes: 1_311_120_679,
    notes:
      'The multilingual one, and the reason search can match 夜景 to "night view" at all. ' +
      'Large: 1.3 GB to download, ~2.3 GB unpacked, because the fp32 export keeps its ' +
      'weights in a separate model.onnx_data file. Quantise it afterwards to get that ' +
      'down to 561 MB — see the note under `quantise` below.',
    /**
     * Turning the 2.3 GB fp32 export into the 561 MB int8 one, on this machine.
     *
     * Worth having rather than shipping a second download, and worth trusting:
     * `quantize_dynamic(..., weight_type=QInt8)` on this file with onnxruntime
     * 1.30.0 reproduces a known-good int8 copy **bit for bit** — 560,662,568
     * bytes, sha256 9dea7aca68a3bff916953106c374a0b1d92cdc65acaae10c7d14e8ddaafc99cc
     * — and the tokenizer is already byte-identical. So there is one reachable
     * download and one local step, with no model hub anywhere in it.
     *
     * Measured through the project's own encoder, `query:` against `passage:`:
     * fp32 puts cos(夜景, "night view of the city") at 0.8391 against
     * cos(夜景, "料理を食べている") at 0.8291; int8 gives 0.8315 and 0.8285. The
     * ordering search depends on survives, and the two agree to about 0.008.
     */
    quantise: {
      from: 'model.onnx',
      to: 'model.int8.onnx',
      sha256: '9dea7aca68a3bff916953106c374a0b1d92cdc65acaae10c7d14e8ddaafc99cc',
      bytes: 560_662_568,
    },
    archive: {
      url: 'https://storage.googleapis.com/qdrant-fastembed/fast-multilingual-e5-large.tar.gz',
      sha256: '6de9742c12bc29e37a0ac49521eda668028424c8068df8ca4941861e504a9d40',
      bytes: 1_311_120_679,
      // The tarball's own top-level directory, which becomes the model dir.
      strip: 'fast-multilingual-e5-large',
      contains: [
        {
          name: 'model.onnx',
          sha256: '1c09780c907c8a91a77a6ab1fd231f79e090d2907ca431223703dfebeed3d36c',
          bytes: 545_851,
        },
        {
          name: 'model.onnx_data',
          sha256: '0cf1883fee81c63819a44e2ba0efa51d4043d9759685a4ebebbde97e0623d15c',
          bytes: 2_235_363_328,
        },
        {
          name: 'tokenizer.json',
          sha256: 'f59925fcb90c92b894cb93e51bb9b4a6105c5c249fe54ce1c704420ac39b81af',
          bytes: 17_082_756,
        },
      ],
    },
  },
  {
    id: 'minilm-l6',
    stage: 'embed_text',
    env: 'OEA_TEXT_MODEL',
    title: 'all-MiniLM-L6-v2, ONNX — small, English only',
    licence: 'Apache-2.0',
    bytes: 83_180_180,
    notes:
      'Here because 1.3 GB is a lot to ask first time, and it is NOT a multilingual ' +
      'substitute. Measured after provisioning it with this script and loading it through ' +
      'the project\'s own encoder: cos(夜景, "night view of the city") = 0.347 while ' +
      'cos(夜景, "料理を食べている") = 0.502. It ranks the wrong one higher — which is the ' +
      'exact failure multilingual-e5-large is here to avoid. Fine for English projects, ' +
      'wrong for the ones this was built for.',
    archive: {
      url: 'https://storage.googleapis.com/qdrant-fastembed/sentence-transformers-all-MiniLM-L6-v2.tar.gz',
      sha256: '2735afe656e156af64ed603dbb1c96f3cae7f937286a8feb27fff7fa979f6a77',
      bytes: 83_180_180,
      strip: 'sentence-transformers-all-MiniLM-L6-v2',
      contains: [{ name: 'model.onnx', bytes: 90_387_630 }, { name: 'tokenizer.json' }],
    },
  },
  {
    id: 'ced-tiny',
    stage: 'analyze_audio',
    env: 'OEA_AUDIO_TAGGER',
    title: 'CED-tiny audio tagging (AudioSet)',
    // Checked rather than assumed: the bundled README names RicherMans/CED as
    // the source of the weights, and that repository's LICENSE is GPL-3.0. The
    // sherpa-onnx repository that publishes the conversion is Apache-2.0, which
    // is what makes this genuinely contested rather than settled. It is opt-in
    // for that reason and the backend ships no default.
    licence: 'GPL-3.0 (weights converted from RicherMans/CED) — opt-in for that reason',
    bytes: 28_531_989,
    notes:
      '6 MB int8, 120x realtime on one core, zero false positives on laughter and ' +
      'applause across 28 clips. Without it the has_laughter and has_music rules ' +
      'cannot fire at all.',
    archive: {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2',
      sha256: '84baf315b57d61aa69480c4fee878dab54cbc7be3e877db334e65d8b087e23c3',
      bytes: 28_531_989,
      strip: 'sherpa-onnx-ced-tiny-audio-tagging-2024-04-19',
      contains: [
        {
          name: 'model.int8.onnx',
          sha256: '73aa22e783115f6a4ae169b36089907e07d0fd44795595eddea9c1bfc74cc945',
          bytes: 6_133_417,
        },
        {
          name: 'model.onnx',
          sha256: 'afe72c1243ec84157d12231e4ea15152a7b438273f6eb06d260fac3e4dd2a4df',
          bytes: 22_256_662,
        },
        { name: 'class_labels_indices.csv' },
      ],
    },
  },
];

/**
 * Stages whose weights cannot be fetched by this script, and why.
 *
 * Listed rather than omitted: someone reading `list` and seeing no `transcribe`
 * row would reasonably conclude transcription needs nothing.
 */
export const NOT_FETCHABLE = [
  {
    stage: 'transcribe',
    env: 'OEA_ASR_MODEL',
    why: [
      'faster-whisper loads CTranslate2 weights (model.bin, config.json,',
      'tokenizer.json, vocabulary.txt) and the only hosts that publish them are',
      'huggingface.co and its mirrors. Where those are reachable, faster-whisper',
      'downloads them itself on first use and there is nothing to do. Where they',
      'are not, copy a converted directory in by hand and point OEA_ASR_MODEL at',
      'it — no PyPI package ships one, and converting needs torch.',
    ].join(' '),
  },
  {
    stage: 'ocr',
    env: '—',
    why:
      'rapidocr-onnxruntime ships its three PaddleOCR models inside the wheel, so ' +
      '`pip install` is the whole provisioning step.',
  },
  {
    stage: 'describe / judgement',
    env: 'OEA_VLM_BASE_URL, OEA_DECISION_BASE_URL',
    why:
      'These are HTTP endpoints, not files: any OpenAI-compatible server will do. ' +
      '"oea doctor" reports which of them this machine can actually reach.',
  },
];

/* -------------------------------------------------------------------------- */

const colour = process.stdout.isTTY
  ? {
      dim: (s) => `[2m${s}[0m`,
      bold: (s) => `[1m${s}[0m`,
      red: (s) => `[31m${s}[0m`,
      green: (s) => `[32m${s}[0m`,
    }
  : { dim: (s) => s, bold: (s) => s, red: (s) => s, green: (s) => s };

function human(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads to `path`, then checks it.
 *
 * Checked after writing rather than while streaming, so that a partial transfer
 * that happens to hash correctly is impossible and a failure leaves nothing
 * behind. A wrong file on disk is worse than no file: the next run finds it,
 * skips the download and loads it.
 */
async function fetchChecked(url, path, { sha256, bytes }) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  process.stdout.write(`  ${colour.dim(url)}\n    `);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length') ?? bytes ?? 0);
  const body = Readable.fromWeb(response.body);
  // Only on a terminal. Carriage returns do not collapse in a log file or in
  // CI, where this otherwise writes one line per chunk — a 1.3 GB download
  // becomes tens of thousands of lines of progress bar.
  if (process.stdout.isTTY && total > 0) {
    let written = 0;
    body.on('data', (chunk) => {
      written += chunk.length;
      process.stdout.write(`\r    ${human(written)} / ${human(total)}   `);
    });
  }
  await pipeline(body, createWriteStream(partial));
  if (process.stdout.isTTY) process.stdout.write('\r');

  const digest = await sha256Of(partial);
  if (sha256 && digest !== sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `${url}\n    expected sha256 ${sha256}\n    got      sha256 ${digest}\n` +
        '    The file at that URL is not the one this project was measured against.',
    );
  }
  const { size } = await stat(partial);
  if (bytes && size !== bytes) {
    await rm(partial, { force: true });
    throw new Error(`${url} is ${size} bytes, expected ${bytes}`);
  }

  const { rename } = await import('node:fs/promises');
  await rename(partial, path);
  console.log(`    ${colour.green('ok')} ${human(size)}  ${digest.slice(0, 16)}…`);
}

/** Noise from tarballs that were built on a Mac. Not a problem, not worth showing. */
const TAR_NOISE = /Ignoring unknown extended header keyword/;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      for (const line of chunk.split('\n')) {
        if (line.trim() && !TAR_NOISE.test(line)) process.stderr.write(`${line}\n`);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}\n${stderr}`)),
    );
  });
}

async function unpack(archivePath, into, strip) {
  await mkdir(into, { recursive: true });
  // `tar` rather than a library: it is on every machine this runs on, it handles
  // both gz and bz2, and a dependency for this would be the only one in the
  // repository's scripts.
  const args = ['-xf', archivePath, '-C', into];
  if (strip) args.push('--strip-components=1');
  await run('tar', args);
}

async function verifyContents(dir, contains) {
  for (const entry of contains) {
    const path = join(dir, entry.name);
    if (!(await exists(path))) throw new Error(`the archive did not contain ${entry.name}`);
    if (entry.bytes) {
      const { size } = await stat(path);
      if (size !== entry.bytes)
        throw new Error(`${entry.name} is ${size} bytes, expected ${entry.bytes}`);
    }
    if (entry.sha256) {
      const digest = await sha256Of(path);
      if (digest !== entry.sha256) {
        throw new Error(`${entry.name}\n    expected ${entry.sha256}\n    got      ${digest}`);
      }
    }
    console.log(`    ${colour.green('ok')} ${entry.name}`);
  }
}

async function get(model, root) {
  const dir = join(root, model.id);
  console.log(`${colour.bold(model.id)} — ${model.title}`);
  console.log(`  licence: ${model.licence}`);
  console.log(`  into:    ${dir}`);

  if (model.files) {
    for (const file of model.files) {
      const path = join(dir, file.name);
      if (await exists(path)) {
        const digest = await sha256Of(path);
        if (digest === file.sha256) {
          console.log(`  ${file.name} ${colour.dim('already here and correct')}`);
          continue;
        }
        console.log(`  ${file.name} ${colour.red('is here but does not match — replacing')}`);
      }
      await fetchChecked(file.url, path, file);
    }
  }

  if (model.archive) {
    const archivePath = join(
      root,
      '.archives',
      `${model.id}${model.archive.url.slice(model.archive.url.lastIndexOf('.'))}`,
    );
    const marker = join(dir, '.verified');
    if (await exists(marker)) {
      console.log(`  ${colour.dim('already unpacked and verified')}`);
    } else {
      if (!(await exists(archivePath)))
        await fetchChecked(model.archive.url, archivePath, model.archive);
      await unpack(archivePath, dir, model.archive.strip);
      await verifyContents(dir, model.archive.contains ?? []);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(marker, `${model.archive.sha256}\n`);
      // The tarball is not needed again and is the largest thing here.
      await rm(archivePath, { force: true });
    }
  }

  console.log(`\n  ${colour.bold(`export ${model.env}=${dir}`)}\n`);
  return dir;
}

/**
 * The int8 conversion, run locally rather than downloaded.
 *
 * Needs `python3` with `onnxruntime`, which the perception runtime already
 * requires. Shelled out because the quantiser is a Python library and there is
 * no reason to reimplement it.
 */
async function quantise(model, root) {
  if (!model.quantise) {
    console.error(`${model.id} has nothing to quantise`);
    process.exitCode = 2;
    return;
  }
  const dir = join(root, model.id);
  const source = join(dir, model.quantise.from);
  const target = join(dir, model.quantise.to);
  if (!(await exists(source))) {
    console.error(`${source} is not there — run "models get ${model.id}" first`);
    process.exitCode = 2;
    return;
  }
  if (await exists(target)) {
    const digest = await sha256Of(target);
    if (digest === model.quantise.sha256) {
      console.log(`${colour.bold(model.id)} ${colour.dim('already quantised and correct')}`);
      return;
    }
  }

  console.log(`${colour.bold(model.id)} — quantising ${model.quantise.from} to int8`);
  console.log(colour.dim('  a few minutes, and it wants several gigabytes of memory'));
  await run('python3', [
    '-c',
    [
      'import sys',
      'from onnxruntime.quantization import quantize_dynamic, QuantType',
      'quantize_dynamic(sys.argv[1], sys.argv[2], weight_type=QuantType.QInt8)',
    ].join('\n'),
    source,
    target,
  ]);

  const digest = await sha256Of(target);
  if (digest !== model.quantise.sha256) {
    // Not fatal, because a different onnxruntime legitimately produces
    // different bytes — but it does mean this is no longer the file every
    // measurement in this project was taken against, and nobody should find
    // that out from a search result.
    console.log(`  ${colour.red('note')} the result does not match the recorded digest`);
    console.log(`    expected ${model.quantise.sha256}`);
    console.log(`    got      ${digest}`);
    console.log('    A different onnxruntime version will do this. The model still works,');
    console.log("    but it is not the one this project's numbers were measured on.");
  } else {
    console.log(`  ${colour.green('ok')} ${digest.slice(0, 16)}… matches the recorded build`);
  }
  console.log(`\n  ${colour.bold(`export ${model.env}=${dir}`)}`);
  console.log(`  ${colour.dim(`then rename ${model.quantise.to} to model.onnx, or keep both`)}\n`);
}

async function list(root) {
  console.log(colour.bold('models this project can fetch\n'));
  for (const model of MODELS) {
    const there = await exists(join(root, model.id));
    console.log(
      `  ${there ? colour.green('●') : colour.dim('○')} ${model.id.padEnd(14)} ${human(model.bytes).padStart(7)}  ${model.title}`,
    );
    console.log(`    ${colour.dim(`${model.stage} · ${model.env} · ${model.licence}`)}`);
    console.log(`    ${colour.dim(model.notes)}`);
  }
  console.log(`\n  ${colour.dim(`● already in ${root}`)}`);

  console.log(`\n${colour.bold('stages with nothing to fetch')}\n`);
  for (const entry of NOT_FETCHABLE) {
    console.log(`  ${entry.stage.padEnd(22)} ${colour.dim(entry.env)}`);
    console.log(`    ${colour.dim(entry.why)}`);
  }
}

/** Re-hashes what is on disk. For "is this the model I think it is?". */
async function check(root) {
  let bad = 0;
  for (const model of MODELS) {
    const dir = join(root, model.id);
    if (!(await exists(dir))) continue;
    console.log(colour.bold(model.id));
    const expected = model.files ?? model.archive?.contains ?? [];
    for (const entry of expected) {
      const path = join(dir, entry.name);
      if (!(await exists(path))) {
        console.log(`  ${colour.red('missing')} ${entry.name}`);
        bad += 1;
        continue;
      }
      if (!entry.sha256) {
        console.log(`  ${colour.dim('present')} ${entry.name}`);
        continue;
      }
      const digest = await sha256Of(path);
      const ok = digest === entry.sha256;
      if (!ok) bad += 1;
      console.log(`  ${ok ? colour.green('ok') : colour.red('WRONG')} ${entry.name}`);
    }
  }
  if (bad > 0) {
    console.error(`\n${bad} file(s) are not what they should be. Re-fetch them.`);
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  // Walked rather than filtered by index. The filter version dropped whichever
  // name happened to sit at index 0 when `--to` was absent, so
  // `models.mjs get clip-vit-b32` silently printed the list instead.
  let root = DEFAULT_ROOT;
  const names = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--to') {
      root = rest[i + 1] ?? root;
      i += 1;
      continue;
    }
    names.push(rest[i]);
  }

  if (!command || command === 'list') return list(root);
  if (command === 'check') return check(root);
  if (command !== 'get' && command !== 'quantise') {
    console.error('usage: models.mjs [list | get <id…> | quantise <id> | check] [--to DIR]');
    process.exitCode = 2;
    return;
  }

  const wanted = names;
  if (wanted.length === 0) {
    console.error('which one? try: models.mjs list');
    process.exitCode = 2;
    return;
  }
  for (const name of wanted) {
    const model = MODELS.find((entry) => entry.id === name);
    if (!model) {
      console.error(`there is no model called "${name}". Try: models.mjs list`);
      process.exitCode = 2;
      return;
    }
    if (command === 'quantise') await quantise(model, root);
    else await get(model, root);
  }
}

await main();

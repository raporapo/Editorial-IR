import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileProject } from '@editorial-ir/core';
import { HeuristicDecisionBackend } from '@editorial-ir/decision';
import { SkillRegistry } from '@editorial-ir/skills';
import { planEdit, validatePlan } from '@editorial-ir/agent';
import {
  AviUtl2Adapter,
  OtioAdapter,
  PremiereAdapter,
  buildAviUtlJob,
  buildExo,
  buildFcpXml,
  buildOtioTimeline,
  createAdapter,
  escapeXml,
  listAdapters,
  msToFrames,
  negotiate,
  toFileUrl,
  type ApplyRequest,
} from '@editorial-ir/adapters';
import { operationTimelineDuration, type EditPlan } from '@editorial-ir/contracts';
import { exampleSuite, makeExampleProject } from './support/project.js';
import { childText, findAll, parseXml } from './support/xml.js';

const registry = SkillRegistry.withBuiltIns();

async function prepared() {
  const store = await makeExampleProject();
  const { ir, observations } = await compileProject({
    store,
    suite: exampleSuite(),
    decision: new HeuristicDecisionBackend(),
  });
  const plan = planEdit({
    ir,
    skill: registry.resolve('travel-vlog'),
    targetDurationMs: 180_000,
    observations,
  });
  const request: ApplyRequest = {
    plan,
    ir,
    projectRoot: store.paths.root,
    outputDir: mkdtempSync(join(tmpdir(), 'editorial-ir-out-')),
    name: 'trip',
  };
  return { store, ir, plan, request };
}

describe('the adapter registry', () => {
  it('ships the three adapters, each declaring what it can do', () => {
    const adapters = listAdapters();
    expect(adapters.map((a) => a.id).sort()).toEqual(['aviutl2', 'otio', 'premiere']);
    for (const capabilities of adapters) {
      expect(capabilities.output_extensions.length).toBeGreaterThan(0);
      expect(capabilities.notes.length).toBeGreaterThan(0);
    }
  });

  it('refuses an adapter that does not exist, and says which do', () => {
    expect(() => createAdapter('resolve')).toThrow(/no adapter called "resolve"/);
  });
});

describe('capability negotiation', () => {
  const basePlan = (overrides: Partial<EditPlan['tracks']['video'][number]>): EditPlan => ({
    edit_plan_version: '0.1.0',
    id: 'plan_x',
    project_id: 'prj_x',
    created_at: '2026-05-17T00:00:00.000Z',
    ir_fingerprint: 'f',
    skill: { name: 's', version: '1' },
    sequence: {
      name: 's',
      target_duration_ms: 1000,
      tolerance_ms: 0,
      width: 1920,
      height: 1080,
      frame_rate: 30,
      frame_rate_num: 30,
      frame_rate_den: 1,
      sample_rate: 48_000,
    },
    tracks: {
      video: [
        {
          operation_id: 'op_0001',
          source_asset_id: 'asset_001',
          source_in_ms: 0,
          source_out_ms: 2000,
          timeline_start_ms: 0,
          track: 0,
          speed: 1,
          use_source_audio: true,
          provenance: 'agent_derived',
          ...overrides,
        },
      ],
      audio: [],
      text: [],
    },
    intent: { tone: [] },
    rationale: [],
    stats: {
      operation_count: 1,
      total_duration_ms: 2000,
      duration_error_ms: 0,
      compression_ratio: 0.1,
      events_selected: 1,
      events_available: 1,
      mean_importance: 0.5,
      mean_continuity: 0.5,
    },
  });

  it('turns an unsupported transition into a cut, and says so', () => {
    const plan = basePlan({ transition_in: { type: 'cross_dissolve', duration_ms: 500 } });
    const { plan: adjusted, downgrades } = negotiate(plan, new AviUtl2Adapter().capabilities);
    expect(adjusted.tracks.video[0]!.transition_in!.type).toBe('cross_dissolve');
    expect(downgrades).toHaveLength(0);

    const premiere = negotiate(
      basePlan({ transition_in: { type: 'fade_in', duration_ms: 500 } }),
      new PremiereAdapter().capabilities,
    );
    expect(premiere.plan.tracks.video[0]!.transition_in!.type).toBe('hard_cut');
    expect(premiere.downgrades[0]!.action).toContain('became a cut');
  });

  it('resets speed the target cannot change', () => {
    const { plan, downgrades } = negotiate(basePlan({ speed: 2 }), new OtioAdapter().capabilities);
    expect(plan.tracks.video[0]!.speed).toBe(1);
    expect(downgrades[0]!.capability).toBe('speed_change');
  });

  it('never changes a plan a target can already do', () => {
    const plan = basePlan({});
    const { plan: adjusted, downgrades } = negotiate(plan, new OtioAdapter().capabilities);
    expect(downgrades).toEqual([]);
    expect(JSON.stringify(adjusted)).toBe(JSON.stringify(plan));
  });
});

describe('the OpenTimelineIO adapter', () => {
  it('writes a timeline with one clip per operation', async () => {
    const { plan, request } = await prepared();
    const document = buildOtioTimeline(plan, request) as Record<string, any>;

    expect(document.OTIO_SCHEMA).toBe('Timeline.1');
    expect(document.tracks.OTIO_SCHEMA).toBe('Stack.1');
    const track = document.tracks.children[0];
    expect(track.OTIO_SCHEMA).toBe('Track.1');
    expect(track.kind).toBe('Video');

    const clips = track.children.filter((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clips).toHaveLength(plan.tracks.video.length);
  });

  it('keeps an NTSC rate exact rather than rounding it', async () => {
    const { plan, request } = await prepared();
    const document = buildOtioTimeline(plan, request) as Record<string, any>;
    const rate = document.global_start_time.rate;
    expect(rate).toBeCloseTo(30000 / 1001, 6);
    expect(rate).not.toBe(30);
  });

  it('points at the media with a file URL', async () => {
    const { plan, request } = await prepared();
    const document = buildOtioTimeline(plan, request) as Record<string, any>;
    const clip = document.tracks.children[0].children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clip.media_reference.OTIO_SCHEMA).toBe('ExternalReference.1');
    expect(clip.media_reference.target_url.startsWith('file:///')).toBe(true);
    expect(clip.media_reference.target_url).toContain('IMG_');
  });

  it('carries the reasoning through in its own namespace', async () => {
    const { plan, request } = await prepared();
    const document = buildOtioTimeline(plan, request) as Record<string, any>;
    const clip = document.tracks.children[0].children.find((c: any) => c.OTIO_SCHEMA === 'Clip.1');
    expect(clip.metadata['editorial-ir'].event_id).toMatch(/^evt_/);
    expect(document.metadata['editorial-ir'].ir_fingerprint).toBe(plan.ir_fingerprint);
  });

  it('writes a file that parses as JSON', async () => {
    const { request } = await prepared();
    const result = await new OtioAdapter().apply(request);
    const artifact = result.artifacts[0]!;
    expect(artifact.path.endsWith('.otio')).toBe(true);
    expect(() => JSON.parse(readFileSync(artifact.path, 'utf8'))).not.toThrow();
  });

  it('measures clip durations in frames at the sequence rate', async () => {
    // A clip's length is the distance to where the next one starts on the frame
    // grid, not its own millisecond duration rounded in isolation: the two
    // differ by a frame whenever rounding goes the other way, and a track is a
    // run of durations, so that frame would move everything after it.
    const { plan, request } = await prepared();
    const document = buildOtioTimeline(plan, request) as Record<string, any>;
    const clips = document.tracks.children[0].children.filter(
      (c: any) => c.OTIO_SCHEMA === 'Clip.1',
    );
    for (const [index, clip] of clips.entries()) {
      const operation = plan.tracks.video[index]!;
      const next = plan.tracks.video[index + 1];
      const start = msToFrames(operation.timeline_start_ms, 30000, 1001);
      const wanted = msToFrames(operationTimelineDuration(operation), 30000, 1001);
      const expected = next
        ? Math.min(wanted, msToFrames(next.timeline_start_ms, 30000, 1001) - start)
        : wanted;
      expect(clip.source_range.duration.value).toBe(expected);
      expect(Math.abs(clip.source_range.duration.value - wanted)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the Premiere adapter', () => {
  it('writes xmeml that Premiere would recognise', async () => {
    const { plan, request } = await prepared();
    const xml = buildFcpXml(plan, request);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE xmeml>');
    expect(xml).toContain('<xmeml version="4">');
    expect(xml).toContain('<sequence id="sequence-1">');
  });

  it('writes an NTSC rate as timebase plus a flag', async () => {
    const { plan, request } = await prepared();
    const xml = buildFcpXml(plan, request);
    expect(xml).toContain('<timebase>30</timebase>');
    expect(xml).toContain('<ntsc>TRUE</ntsc>');
  });

  it('declares each source file once and references it after that', async () => {
    const { plan, request } = await prepared();
    const xml = buildFcpXml(plan, request);
    const declarations = xml.match(/<file id="file-\d+">/g) ?? [];
    const references = xml.match(/<file id="file-\d+"\/>/g) ?? [];
    // Three recordings, many clips: three declarations, the rest references.
    expect(declarations).toHaveLength(3);
    expect(references.length).toBeGreaterThan(plan.tracks.video.length - 4);
  });

  it('carries the reasoning into the clip comments', async () => {
    const { plan, request } = await prepared();
    const xml = buildFcpXml(plan, request);
    expect(xml).toContain('<mastercomment1>');
  });

  it('has one picture clipitem per operation, and sound beside it', async () => {
    const { plan, request } = await prepared();
    const root = parseXml(buildFcpXml(plan, request));
    const media = root.children
      .find((child) => child.tag === 'sequence')!
      .children.find((child) => child.tag === 'media')!;
    const video = media.children.find((child) => child.tag === 'video')!;
    const audio = media.children.find((child) => child.tag === 'audio')!;

    expect(findAll(video, 'clipitem')).toHaveLength(plan.tracks.video.length);
    // Sound is only under the clips that asked for it, on one track per channel.
    const wanting = plan.tracks.video.filter((operation) => operation.use_source_audio).length;
    expect(findAll(audio, 'clipitem').length % wanting).toBe(0);
  });

  it('escapes user content, because one unescaped ampersand breaks the file', () => {
    expect(escapeXml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
    expect(escapeXml('a "quoted" \u2018thing\u2019')).toContain('&quot;');
    expect(escapeXml('やっと着いた！')).toBe('やっと着いた！');
  });

  it('writes a file to disk', async () => {
    const { request } = await prepared();
    const result = await new PremiereAdapter().apply(request);
    expect(result.artifacts[0]!.path.endsWith('.xml')).toBe(true);
    expect(readFileSync(result.artifacts[0]!.path, 'utf8')).toContain('<xmeml');
  });
});

describe('the AviUtl2 adapter', () => {
  it('writes a versioned job plus a best-effort object file', async () => {
    const { request } = await prepared();
    const result = await new AviUtl2Adapter().apply(request);
    expect(result.artifacts.map((a) => a.kind).sort()).toEqual(['interchange', 'project']);
    expect(result.warnings.join(' ')).toContain('best effort');
  });

  it('counts frames from one, as AviUtl does', async () => {
    const { plan, request } = await prepared();
    const job = buildAviUtlJob(plan, request) as Record<string, any>;
    expect(job.clips[0].start_frame).toBe(1);
    expect(job.job_version).toBe('0.1.0');
  });

  it('keeps an NTSC rate exact in the exo, as the JSON job beside it does', async () => {
    // ExEdit's rate and scale are the rational pair — fps is rate/scale — which
    // is why scale exists. Rounding 30000/1001 to rate=30, scale=1 declares a
    // 30 fps project for frame numbers computed at 29.97: everything plays a
    // tenth of a percent fast, and audio drifts against picture by about a fifth
    // of a second every three minutes.
    const { plan, request } = await prepared();
    const ntsc: EditPlan = {
      ...plan,
      sequence: { ...plan.sequence, frame_rate_num: 30_000, frame_rate_den: 1001 },
    };

    const exo = buildExo(ntsc, request);
    expect(exo).toContain('rate=30000');
    expect(exo).toContain('scale=1001');

    // The two outputs of this one adapter must agree about what a frame is.
    const job = buildAviUtlJob(ntsc, request) as Record<string, any>;
    expect(job.sequence.frame_rate_num).toBe(30_000);
    expect(job.sequence.frame_rate_den).toBe(1001);
  }, 60_000);

  it('writes a whole frame rate without a denominator that changes it', async () => {
    const { plan, request } = await prepared();
    const whole: EditPlan = {
      ...plan,
      sequence: { ...plan.sequence, frame_rate_num: 30, frame_rate_den: 1 },
    };
    const exo = buildExo(whole, request);
    expect(exo).toContain('rate=30');
    expect(exo).toContain('scale=1');
  }, 60_000);

  it('writes layers one-based and the source offset in frames', async () => {
    const { plan, request } = await prepared();
    const job = buildAviUtlJob(plan, request) as Record<string, any>;
    for (const clip of job.clips) {
      expect(clip.layer).toBeGreaterThanOrEqual(1);
      expect(clip.source_offset_frame).toBeGreaterThanOrEqual(0);
      expect(clip.end_frame).toBeGreaterThanOrEqual(clip.start_frame);
    }
  });

  it('writes an exo with the blocks a video clip needs', async () => {
    const { plan, request } = await prepared();
    const exo = buildExo(plan, request);
    expect(exo.startsWith('[exedit]')).toBe(true);
    expect(exo).toContain('_name=動画ファイル');
    expect(exo).toContain('_name=標準描画');
    // Exchanged on Windows, so CRLF.
    expect(exo).toContain('\r\n');
    expect(exo.match(/^\[\d+\]$/gm) ?? []).toHaveLength(plan.tracks.video.length);
  });
});

describe('the sound', () => {
  // A cut with no sound is not a rough cut. The plan names which clips carry
  // their own audio and declares the tracks to lay it on; both were read and
  // neither was written, so every sequence and every timeline arrived silent
  // while the capabilities advertised two audio tracks.
  it('puts the source audio in the Premiere sequence, linked to its picture', async () => {
    const { plan, request } = await prepared();
    const root = parseXml(buildFcpXml(plan, request));
    const sequence = root.children.find((child) => child.tag === 'sequence')!;
    const media = sequence.children.find((child) => child.tag === 'media')!;
    const audio = media.children.find((child) => child.tag === 'audio')!;
    const video = media.children.find((child) => child.tag === 'video')!;

    const audioClips = findAll(audio, 'clipitem');
    expect(audioClips.length).toBeGreaterThan(0);

    // Every audio clip names a picture clip that exists, or the editor gets
    // sound it cannot move with the shot it belongs to.
    const pictureIds = new Set(findAll(video, 'clipitem').map((clip) => clip.attributes.id));
    const links = audioClips.flatMap((clip) => findAll(clip, 'linkclipref').map((ref) => ref.text));
    const toPicture = links.filter((ref) => pictureIds.has(ref));
    expect(toPicture.length).toBeGreaterThan(0);
    for (const ref of links) {
      expect(pictureIds.has(ref) || ref.startsWith('clipitem-a')).toBe(true);
    }
  }, 60_000);

  it('gives OTIO an audio track for the clips that carry their own sound', async () => {
    const { plan, request } = await prepared();
    const timeline = buildOtioTimeline(plan, request) as unknown as {
      tracks: { children: { kind: string; children: { OTIO_SCHEMA: string }[] }[] };
    };

    const audio = timeline.tracks.children.filter((track) => track.kind === 'Audio');
    expect(audio.length).toBeGreaterThan(0);
    const clips = audio[0]!.children.filter((child) => child.OTIO_SCHEMA.startsWith('Clip'));
    expect(clips.length).toBeGreaterThan(0);

    // Only the clips that asked for it, and the rest left as gaps so the two
    // tracks stay aligned.
    const wanting = plan.tracks.video.filter((operation) => operation.use_source_audio).length;
    expect(clips).toHaveLength(wanting);
  }, 60_000);

  it('says so rather than silently dropping a bed it cannot write', async () => {
    const { plan, request } = await prepared();
    const withBed: EditPlan = {
      ...plan,
      tracks: {
        ...plan.tracks,
        audio: [
          ...plan.tracks.audio,
          {
            type: 'external',
            track: 1,
            asset_id: request.ir.assets[0]!.id,
            source_in_ms: 0,
            timeline_start_ms: 0,
            gain_db: -18,
          },
        ],
      },
    } as unknown as EditPlan;

    const warnings: string[] = [];
    buildFcpXml(withBed, request, warnings);
    expect(warnings.some((warning) => warning.includes('external audio bed'))).toBe(true);
  }, 60_000);

  it('gives every clip one length, not two that disagree', async () => {
    // `end - start` and `out - in` were rounded independently and differed by a
    // frame on 14 of the 39 clips in the worked example. A clipitem whose two
    // lengths conflict is one the importer resolves by guessing.
    const { plan, request } = await prepared();
    const root = parseXml(buildFcpXml(plan, request));

    const clips = findAll(root, 'clipitem');
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      const at = (tag: string) => Number(childText(clip, tag));
      expect(at('end') - at('start')).toBe(at('out') - at('in'));
    }
  }, 60_000);
});

describe('would it actually import', () => {
  // Everything above asserts on substrings, which an unbalanced tag, a stray
  // "<" or a wrongly placed `continue` all survive. These are the properties a
  // real import depends on, and the interchange file is the last artefact in the
  // pipeline: every stage above it is worthless if this will not open.
  it('writes XML that parses as a document', async () => {
    const { plan, request } = await prepared();
    const root = parseXml(buildFcpXml(plan, request));
    expect(root.tag).toBe('xmeml');
    expect(root.attributes.version).toBe('4');
  }, 60_000);

  it('points every file reference at a file definition', async () => {
    // A reference with no definition imports as an offline clip, which is the
    // classic way an FCP7 XML looks fine and arrives empty.
    const { plan, request } = await prepared();
    const root = parseXml(buildFcpXml(plan, request));

    const files = findAll(root, 'file');
    const definitions = new Set(
      files.filter((file) => file.children.length > 0).map((file) => file.attributes.id),
    );
    const references = files.filter((file) => file.children.length === 0);

    expect(definitions.size).toBe(request.ir.assets.length);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(definitions.has(reference.attributes.id)).toBe(true);
  }, 60_000);

  it('gives every clip a distinct id', async () => {
    const { plan, request } = await prepared();
    const ids = findAll(parseXml(buildFcpXml(plan, request)), 'clipitem').map(
      (c) => c.attributes.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  it('never overlaps two clips on one track', async () => {
    // Two clips claiming the same frames is the one structural error a sequence
    // cannot represent, so the importer resolves it by guessing.
    const { plan, request } = await prepared();
    const root = parseXml(buildFcpXml(plan, request));

    for (const track of findAll(root, 'track')) {
      const spans = track.children
        .filter((child) => child.tag === 'clipitem')
        .map((clip) => [Number(childText(clip, 'start')), Number(childText(clip, 'end'))] as const)
        .sort((a, b) => a[0] - b[0]);

      expect(spans.length).toBeGreaterThan(0);
      for (const [index, span] of spans.entries()) {
        expect(Number.isFinite(span[0])).toBe(true);
        expect(span[1]).toBeGreaterThan(span[0]);
        if (index > 0) expect(span[0]).toBeGreaterThanOrEqual(spans[index - 1]![1]);
      }
    }
  }, 60_000);

  it('gives every OTIO time the sequence rate, or the durations mean nothing', async () => {
    // A RationalTime is a value and a rate, and mixing rates inside one timeline
    // is how a cut silently drifts: everything still parses, the numbers are
    // just measured against different clocks.
    const { plan, request } = await prepared();
    const timeline = buildOtioTimeline(plan, request);

    const rates = new Set<number>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const schema = record.OTIO_SCHEMA;
      if (typeof schema === 'string' && schema.startsWith('RationalTime') && 'rate' in record) {
        rates.add(Number(record.rate));
      }
      Object.values(record).forEach(walk);
    };
    walk(timeline);

    expect(rates.size).toBe(1);
  }, 60_000);

  it('gives every OTIO clip media to point at and a positive duration', async () => {
    const { plan, request } = await prepared();
    type OtioClip = {
      OTIO_SCHEMA: string;
      media_reference?: { target_url?: string };
      source_range?: { duration?: { value?: number } };
    };
    const timeline = buildOtioTimeline(plan, request) as unknown as {
      tracks: { children: { children: OtioClip[] }[] };
    };
    const clips = timeline.tracks.children[0]!.children.filter((child) =>
      child.OTIO_SCHEMA.startsWith('Clip'),
    );

    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      expect(clip.media_reference?.target_url).toMatch(/^file:\/\//);
      expect(clip.source_range?.duration?.value).toBeGreaterThan(0);
    }
  }, 60_000);

  it('survives user content that would otherwise break the document', async () => {
    const { plan, request } = await prepared();
    // File names and descriptions are user content and routinely contain these.
    const hostile = {
      ...request,
      ir: {
        ...request.ir,
        assets: request.ir.assets.map((asset) => ({
          ...asset,
          file_name: `R&D <takes> "one" & 'two'.MOV`,
        })),
      },
    };
    expect(() => parseXml(buildFcpXml(plan, hostile))).not.toThrow();
  }, 60_000);
});

describe('one plan, three editors', () => {
  it('feeds all three adapters from the same EditPlan', async () => {
    const { ir, plan, request } = await prepared();
    expect(validatePlan(plan, { ir }).ok).toBe(true);

    for (const id of ['otio', 'premiere', 'aviutl2']) {
      const adapter = createAdapter(id);
      const result = await adapter.apply({ ...request, name: id });
      expect(result.adapter).toBe(id);
      expect(result.artifacts.length).toBeGreaterThan(0);
      for (const artifact of result.artifacts) {
        expect(artifact.byte_size).toBeGreaterThan(0);
      }
    }
  });

  it('never lets an adapter change what is in the cut', async () => {
    const { plan, request } = await prepared();
    const before = JSON.stringify(plan);
    for (const id of ['otio', 'premiere', 'aviutl2']) {
      await createAdapter(id).apply({ ...request, name: id });
    }
    // An adapter translates; it does not plan.
    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe('toFileUrl', () => {
  it('produces an absolute file URL', () => {
    expect(toFileUrl('/home/user/a b.mov')).toBe('file:///home/user/a%20b.mov');
  });

  it('handles a Windows path', () => {
    expect(toFileUrl('C:\\footage\\a.mov')).toBe('file:///C:/footage/a.mov');
  });
});

/**
 * The dissolves a skill asked for.
 *
 * All three adapters advertise `basic_transition` and name the types they
 * support, so negotiation lets every transition through untouched and records
 * no downgrade. Premiere then wrote none of them: a skill asking for a dissolve
 * at each chapter change produced a sequence of hard cuts, and nothing said so.
 */
describe('the dissolves', () => {
  async function withDissolves() {
    const { ir, plan, request } = await prepared();
    const dissolve = { type: 'cross_dissolve' as const, duration_ms: 800 };
    // Every other clip, so both the transition and the plain cut are exercised.
    const video = plan.tracks.video.map((operation, index) =>
      index > 0 && index % 2 === 0 ? { ...operation, transition_in: dissolve } : operation,
    );
    const withThem = { ...plan, tracks: { ...plan.tracks, video } };
    return { ir, plan: withThem, request: { ...request, plan: withThem } };
  }

  it('writes one into the Premiere sequence for each one asked for', async () => {
    const { plan, request } = await withDissolves();
    const warnings: string[] = [];
    const root = parseXml(buildFcpXml(plan, request, warnings));

    const asked = plan.tracks.video.filter(
      (o) => o.transition_in?.type === 'cross_dissolve',
    ).length;
    const written = findAll(root, 'transitionitem');
    expect(asked).toBeGreaterThan(0);
    expect(written.length + warnings.length).toBe(asked);
    for (const item of written) {
      expect(childText(item, 'alignment')).toBe('center');
      expect(Number(childText(item, 'end'))).toBeGreaterThan(Number(childText(item, 'start')));
    }
  }, 60_000);

  it('leaves a plain cut alone', async () => {
    const { plan, request } = await prepared();
    const video = plan.tracks.video.map(({ transition_in: _in, ...rest }) => rest);
    const cuts = { ...plan, tracks: { ...plan.tracks, video } };
    expect(
      findAll(parseXml(buildFcpXml(cuts, { ...request, plan: cuts })), 'transitionitem'),
    ).toHaveLength(0);
  }, 60_000);

  it('writes the ones the worked example already asks for', async () => {
    // travel-vlog declares a 400ms cross dissolve at each chapter change, so
    // the flagship cut has always carried eleven of them, and the Premiere
    // sequence has always arrived with none.
    const { plan, request } = await prepared();
    const asked = plan.tracks.video.filter(
      (operation) => operation.transition_in && operation.transition_in.type !== 'hard_cut',
    ).length;
    expect(asked).toBeGreaterThan(0);
    expect(findAll(parseXml(buildFcpXml(plan, request)), 'transitionitem')).toHaveLength(asked);
  }, 60_000);

  it('puts each one between the two clips it joins', async () => {
    // An FCP7 transition lives in the track, between the clipitems it belongs
    // to; anywhere else and the importer either ignores it or misplaces it.
    const { plan, request } = await withDissolves();
    const root = parseXml(buildFcpXml(plan, request));

    for (const track of findAll(root, 'track')) {
      const kinds = track.children.map((child) => child.tag);
      for (const [index, kind] of kinds.entries()) {
        if (kind !== 'transitionitem') continue;
        expect(kinds[index - 1]).toBe('clipitem');
        expect(kinds[index + 1]).toBe('clipitem');
      }
    }
  }, 60_000);

  it('does not write one the footage cannot supply', async () => {
    // A dissolve is made of frames neither clip is using, taken from past the
    // outgoing clip's out point and from before the incoming clip's in point.
    // Writing one that is not there is how an XML imports with clips in the
    // wrong places.
    const { plan, request } = await prepared();
    const video = plan.tracks.video.map((operation, index) =>
      index === 1
        ? {
            ...operation,
            source_in_ms: 0,
            transition_in: { type: 'cross_dissolve' as const, duration_ms: 4000 },
          }
        : operation,
    );
    const withIt = { ...plan, tracks: { ...plan.tracks, video } };
    const warnings: string[] = [];
    buildFcpXml(withIt, { ...request, plan: withIt }, warnings);
    expect(warnings.some((w) => /hard cut/.test(w))).toBe(true);
  }, 60_000);

  it('reads the outgoing clip’s transition_out as the same join', async () => {
    // A transition sits between two clips, so the outgoing clip's
    // `transition_out` and the incoming clip's `transition_in` name one object.
    const { plan, request } = await prepared();
    const video = plan.tracks.video.map(({ transition_in: _in, ...rest }, index) =>
      index === 0
        ? { ...rest, transition_out: { type: 'cross_dissolve' as const, duration_ms: 600 } }
        : rest,
    );
    const withIt = { ...plan, tracks: { ...plan.tracks, video } };
    const root = parseXml(buildFcpXml(withIt, { ...request, plan: withIt }));
    expect(findAll(root, 'transitionitem').length).toBe(1);
  }, 60_000);
});

describe('the sound and the picture, frame for frame', () => {
  /** Every item on a track, with the frame it starts on. */
  function laid(track: { children: Record<string, unknown>[] }) {
    let at = 0;
    const items: { start: number; length: number; kind: string; operation?: string }[] = [];
    for (const child of track.children) {
      if (child.OTIO_SCHEMA === 'Transition.1') continue;
      const sourceRange = child.source_range as { duration: { value: number } };
      const meta = (child.metadata as Record<string, Record<string, unknown>> | undefined)?.[
        'editorial-ir'
      ];
      const operation = meta?.operation_id;
      items.push({
        start: at,
        length: sourceRange.duration.value,
        kind: String(child.OTIO_SCHEMA),
        ...(typeof operation === 'string' ? { operation } : {}),
      });
      at += sourceRange.duration.value;
    }
    return items;
  }

  it('puts every audio clip on the same frame as its picture', async () => {
    // A track in OTIO is a run of durations, so an item's position comes from
    // accumulating them — and each track rounded its own. The audio track merges
    // a run of silent clips into one gap and the video track does not, so the
    // two accumulated different error: six of fifteen audio clips came out a
    // frame after their picture, which is a sync fault a person notices in the
    // edit rather than in a diff.
    const { plan, request } = await prepared();
    const timeline = buildOtioTimeline(plan, request) as {
      tracks: { children: { kind: string; children: Record<string, unknown>[] }[] };
    };

    const video = timeline.tracks.children.find((track) => track.kind === 'Video')!;
    const audio = timeline.tracks.children.find((track) => track.kind === 'Audio')!;
    const picture = new Map(
      laid(video)
        .filter((item) => item.operation)
        .map((item) => [item.operation!, item]),
    );

    const sound = laid(audio).filter((item) => item.kind === 'Clip.1');
    expect(sound.length).toBeGreaterThan(0);
    for (const item of sound) {
      const its = picture.get(item.operation!);
      expect(its, `${item.operation} has sound and no picture`).toBeDefined();
      expect([item.start, item.length]).toEqual([its!.start, its!.length]);
    }
  }, 60_000);

  it('leaves a gap rather than closing up behind a silent clip', async () => {
    const { plan, request } = await prepared();
    const timeline = buildOtioTimeline(plan, request) as {
      tracks: { children: { kind: string; children: Record<string, unknown>[] }[] };
    };
    const audio = timeline.tracks.children.find((track) => track.kind === 'Audio')!;
    const silent = plan.tracks.video.filter((operation) => !operation.use_source_audio);
    expect(silent.length).toBeGreaterThan(0);
    expect(laid(audio).some((item) => item.kind === 'Gap.1')).toBe(true);
  }, 60_000);
});

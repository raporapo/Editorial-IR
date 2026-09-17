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
    const { plan, request } = await prepared();
    const document = buildOtioTimeline(plan, request) as Record<string, any>;
    const clips = document.tracks.children[0].children.filter(
      (c: any) => c.OTIO_SCHEMA === 'Clip.1',
    );
    for (const [index, clip] of clips.entries()) {
      const operation = plan.tracks.video[index]!;
      const expected = msToFrames(operationTimelineDuration(operation), 30000, 1001);
      expect(clip.source_range.duration.value).toBe(expected);
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

  it('has one clipitem per operation', async () => {
    const { plan, request } = await prepared();
    const xml = buildFcpXml(plan, request);
    expect(xml.match(/<clipitem id=/g) ?? []).toHaveLength(plan.tracks.video.length);
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

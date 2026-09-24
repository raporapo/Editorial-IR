import {
  CAPTURE_TIMELINE_GAP_MS,
  IR_VERSION,
  NEUTRAL_FLAGS,
  NEUTRAL_METRICS,
  PIPELINE_VERSION,
  seqId,
  type EditorialAssessment,
  type EditorialIR,
  type EventEditorial,
  type MediaAsset,
  type NarrativeRole,
  type RelationType,
  type SemanticEvent,
} from '@editorial-ir/contracts';

/**
 * Builders for hand-written Editorial IR.
 *
 * Unit tests for the index, the planner and the adapters need an IR with
 * specific properties — a redundant pair, an essential event, a jarring cut —
 * which is awkward to arrange by compiling media. These builders make the
 * interesting part of each test the only part that is written out.
 */

const NOW = '2026-09-16T00:00:00.000Z';

export interface EventSpec {
  id?: string;
  start_ms?: number;
  duration_ms?: number;
  asset_id?: string;
  description?: string;
  event_type?: string;
  speech?: string[];
  visual_labels?: string[];
  ocr?: string[];
  audio?: string[];
  people?: string[];
  places?: string[];
  topics?: string[];
  affect?: Record<string, number>;
  chapter_id?: string;
  essential?: boolean;
  excluded?: boolean;
  metrics?: Partial<Record<keyof typeof NEUTRAL_METRICS, number>>;
  flags?: Partial<Record<keyof typeof NEUTRAL_FLAGS, number>>;
  role?: NarrativeRole;
  speech_ratio?: number;
  silence_ratio?: number;
  technical_quality?: number;
}

export function makeEvent(spec: EventSpec, index: number): SemanticEvent {
  const id = spec.id ?? seqId('evt', index + 1);
  const start = spec.start_ms ?? index * 10_000;
  const duration = spec.duration_ms ?? 8000;
  const assetId = spec.asset_id ?? 'asset_001';

  return {
    id,
    ...(spec.chapter_id ? { chapter_id: spec.chapter_id } : {}),
    start_ms: start,
    end_ms: start + duration,
    source_ranges: [{ asset_id: assetId, source_in_ms: start, source_out_ms: start + duration }],
    description: {
      value: spec.description ?? `event ${index + 1}`,
      provenance: 'inferred',
      confidence: 0.5,
    },
    event_type: { value: spec.event_type ?? 'moment', provenance: 'inferred', confidence: 0.5 },
    entities: {
      value: {
        people: spec.people ?? [],
        places: spec.places ?? [],
        objects: [],
        topics: spec.topics ?? [],
        organisations: [],
      },
      provenance: 'inferred',
    },
    affect: { value: spec.affect ?? {}, provenance: 'inferred' },
    observed: {
      speech: (spec.speech ?? []).map((text, i) => ({
        text,
        start_ms: start + i * 1000,
        end_ms: start + i * 1000 + 900,
        confidence: 0.9,
      })),
      visual_labels: spec.visual_labels ?? [],
      ocr: spec.ocr ?? [],
      audio: (spec.audio ?? []).map((type) => ({ type, confidence: 0.7 })),
      shot_ids: [],
      shot_count: 1,
      speech_ratio: spec.speech_ratio ?? (spec.speech?.length ? 0.7 : 0),
      silence_ratio: spec.silence_ratio ?? 0.1,
      ...(spec.technical_quality === undefined
        ? {}
        : { technical_quality: spec.technical_quality }),
    },
    knowledge: {
      notes: [],
      essential: spec.essential ?? false,
      excluded: spec.excluded ?? false,
      annotation_refs: [],
    },
    segmentation: { method: 'shot', boundary_confidence: 0.6 },
    embedding_refs: [],
    confidence: 0.6,
  };
}

export function makeAssessment(eventId: string, spec: EventSpec): EditorialAssessment {
  return {
    id: `asm_${eventId.slice(4)}`,
    event_id: eventId,
    model_run_id: 'run_test',
    metrics: { ...NEUTRAL_METRICS, ...spec.metrics },
    flags: { ...NEUTRAL_FLAGS, ...spec.flags },
    narrative_role: { selected: spec.role ?? 'context', probabilities: {} },
    confidence: 0.5,
  };
}

export function makeAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset_001',
    path: 'footage/clip.mov',
    file_name: 'clip.mov',
    kind: 'video',
    sha256: 'a'.repeat(64),
    byte_size: 1024,
    duration_ms: 600_000,
    width: 1920,
    height: 1080,
    fps: 30,
    fps_num: 30,
    fps_den: 1,
    metadata: {},
    ...overrides,
  };
}

export interface IrSpec {
  events: EventSpec[];
  assets?: MediaAsset[];
  occasion?: string;
  goal?: string;
  tone?: string[];
  targetDurationMs?: number;
  /** `[source, type, target]`, or `[source, type, target, strength]`. */
  relations?: ([string, RelationType, string] | [string, RelationType, string, number])[];
}

export function makeIR(spec: IrSpec): EditorialIR {
  const assets = spec.assets ?? [makeAsset()];
  const events = spec.events.map((s, i) => makeEvent(s, i));
  const editorial: EventEditorial[] = events.map((event, i) => ({
    event_id: event.id,
    current: makeAssessment(event.id, spec.events[i] ?? {}),
    history: [],
  }));

  const totalDuration = assets.reduce((sum, a) => sum + a.duration_ms, 0);

  return {
    ir_version: IR_VERSION,
    pipeline_version: PIPELINE_VERSION,
    generated_at: NOW,
    fingerprint: 'test-fingerprint',
    project: {
      id: 'prj_test',
      title: 'Test project',
      status: 'analyzed',
      ir_version: IR_VERSION,
      created_at: NOW,
      updated_at: NOW,
    },
    context: {
      project_id: 'prj_test',
      background: {
        ...(spec.occasion ? { occasion: spec.occasion } : {}),
        people: [],
        places: [],
        vocabulary: [],
        notes: [],
      },
      editing_goal: {
        ...(spec.targetDurationMs ? { target_duration_ms: spec.targetDurationMs } : {}),
        ...(spec.goal ? { instruction: spec.goal } : {}),
        tone: spec.tone ?? [],
        opening: [],
        middle: [],
        ending: [],
      },
      constraints: {
        forbidden: [],
        required_assets: [],
        excluded_assets: [],
        allow_speed_change: false,
        allowed_music: [],
        forbidden_music: [],
      },
      updated_at: NOW,
    },
    assets,
    placements: assets.map((asset, i) => ({
      asset_id: asset.id,
      offset_ms: i * (assets[0]?.duration_ms ?? 0) + i * CAPTURE_TIMELINE_GAP_MS,
      order: i,
      ordered_by: 'file_name' as const,
    })),
    materials: [],
    chapters: [],
    events,
    editorial,
    relations: (spec.relations ?? []).map(([source, type, target, strength], i) => ({
      id: seqId('rel', i + 1),
      source_event_id: source,
      relation_type: type,
      target_event_id: target,
      strength: strength ?? 0.8,
      provenance: 'inferred' as const,
    })),
    annotations: [],
    conflicts: [],
    model_runs: [],
    // The fixtures stand for a real analysis, so they claim the tier a real
    // analysis would. A test that needs a stand-in recorded overrides it.
    quality: { tier: 'standard', stand_ins: [] },
    stats: {
      asset_count: assets.length,
      total_media_duration_ms: totalDuration,
      event_count: events.length,
      chapter_count: 0,
      relation_count: spec.relations?.length ?? 0,
      utterance_count: 0,
      shot_count: 0,
      mean_event_duration_ms:
        events.length === 0
          ? 0
          : Math.round(events.reduce((s, e) => s + (e.end_ms - e.start_ms), 0) / events.length),
      total_cost_usd: 0,
      compile_ms: 0,
      embedding_kinds: [],
    },
  };
}

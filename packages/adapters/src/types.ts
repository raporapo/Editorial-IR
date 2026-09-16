import type {
  AdapterCapabilities,
  ApplyResult,
  CapabilityDowngrade,
  EditPlan,
  EditorialIR,
} from '@editorial-ir/contracts';

/**
 * The boundary between this project and any editing application.
 *
 * An adapter translates an EditPlan. It never plans, never judges and never
 * reads the Editorial IR for anything but the media it needs to resolve. That
 * separation is what makes a second editor an adapter rather than a rewrite, and
 * it is why the agent is not allowed to speak to an NLE directly.
 */
export interface EditorAdapter {
  readonly capabilities: AdapterCapabilities;

  /** Writes the plan out, as a project file or into a running application. */
  apply(request: ApplyRequest): Promise<ApplyResult>;

  /** Reads a timeline back, where the target can. Used by the review loop. */
  readTimeline?(request: ApplyRequest): Promise<EditPlan | undefined>;

  /** True when this adapter can be used right now on this machine. */
  available?(): Promise<boolean>;
}

export interface ApplyRequest {
  plan: EditPlan;
  /** Needed to resolve asset ids to files on disk. */
  ir: EditorialIR;
  /** Where relative media paths resolve from. */
  projectRoot: string;
  /** Where to write. */
  outputDir: string;
  /** Base name for the produced files, without an extension. */
  name?: string;
  options?: Record<string, unknown>;
}

/**
 * Adjusts a plan to what a target can actually do.
 *
 * Reported rather than performed silently: a dissolve that quietly became a cut
 * is a change to someone's edit, and they are entitled to see the list.
 */
export function negotiate(
  plan: EditPlan,
  capabilities: AdapterCapabilities,
): { plan: EditPlan; downgrades: CapabilityDowngrade[] } {
  const downgrades: CapabilityDowngrade[] = [];

  const video = plan.tracks.video.map((operation) => {
    let next = operation;

    if (operation.speed !== 1 && !capabilities.speed_change) {
      downgrades.push({
        operation_id: operation.operation_id,
        capability: 'speed_change',
        action: 'played at normal speed',
      });
      next = { ...next, speed: 1 };
    }

    if (operation.track >= capabilities.max_video_tracks) {
      downgrades.push({
        operation_id: operation.operation_id,
        capability: 'max_video_tracks',
        action: `moved to track ${capabilities.max_video_tracks - 1}`,
      });
      next = { ...next, track: capabilities.max_video_tracks - 1 };
    }

    for (const side of ['transition_in', 'transition_out'] as const) {
      const transition = next[side];
      if (!transition || transition.type === 'hard_cut') continue;
      const supported =
        capabilities.basic_transition && capabilities.transition_types.includes(transition.type);
      if (supported) continue;
      downgrades.push({
        operation_id: operation.operation_id,
        capability: side,
        action: `${transition.type} became a cut`,
      });
      next = { ...next, [side]: { type: 'hard_cut' as const, duration_ms: 0 } };
    }

    return next;
  });

  let text = plan.tracks.text;
  if (text.length > 0 && !capabilities.text) {
    downgrades.push({
      capability: 'text',
      action: `${text.length} text item(s) left out`,
    });
    text = [];
  }

  const audio = plan.tracks.audio.filter((track) => {
    if (track.track < capabilities.audio_tracks) return true;
    downgrades.push({ capability: 'audio_tracks', action: `audio track ${track.track} left out` });
    return false;
  });

  return { plan: { ...plan, tracks: { video, audio, text } }, downgrades };
}

/** Resolves an asset id to an absolute path on disk. */
export function resolveAssetPath(request: ApplyRequest, assetId: string): string | undefined {
  const asset = request.ir.assets.find((a) => a.id === assetId);
  if (!asset) return undefined;
  return asset.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(asset.path)
    ? asset.path
    : `${request.projectRoot.replace(/\/$/, '')}/${asset.path}`;
}

/** A `file://` URL, which is what every interchange format wants. */
export function toFileUrl(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const withLeadingSlash = normalised.startsWith('/') ? normalised : `/${normalised}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}

/** Converts milliseconds to whole frames at a rational rate. */
export function msToFrames(ms: number, rateNum: number, rateDen: number): number {
  return Math.round((ms / 1000) * (rateNum / rateDen));
}

export function framesToMs(frames: number, rateNum: number, rateDen: number): number {
  return Math.round((frames * 1000 * rateDen) / rateNum);
}

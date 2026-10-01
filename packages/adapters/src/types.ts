import {
  compareText,
  operationTimelineDuration,
  operationTimelineEnd,
  type AdapterCapabilities,
  type ApplyResult,
  type CapabilityDowngrade,
  type EditPlan,
  type EditorialIR,
  type MediaAsset,
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

  /**
   * Reads a timeline back, where the target can. **Nothing calls this yet.**
   *
   * It said "used by the review loop", and there is no such loop: `reviewPlan`
   * works from the plan and the IR alone, which its own header says. No shipped
   * adapter implements this and all of them declare `reads_back_timeline: false`,
   * so `Provenance.nle_observed` — "read back out of an NLE after the plan was
   * applied" — has never been produced either.
   *
   * Left in place rather than deleted because the shape is right and an adapter
   * outside this repository may already implement it. What is corrected here is
   * the claim: a hook is not a feature, and describing one as though a caller
   * exists is how a reader concludes their edits are being read back when
   * nothing is reading them.
   */
  readTimeline?(request: ApplyRequest): Promise<EditPlan | undefined>;

  /**
   * True when this adapter can be used right now on this machine.
   *
   * `oea apply` asks before it validates or writes anything. An adapter that
   * only writes text has nothing to ask and leaves this out; one that runs a
   * program (the preview runs ffmpeg) must answer, or the first sign of a
   * missing program is a half-written output directory.
   */
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
  /**
   * Settings for one target, by name: `width` and `burn_captions` for the
   * preview, `record_start` for an EDL or an FCPXML. Each adapter documents the
   * ones it reads (docs/adapters.md) and ignores the rest, so one `oea apply`
   * command line can be pointed at any editor.
   */
  options?: Record<string, unknown>;
}

/** A numeric option, or the fallback when it is absent or not a finite number. */
export function numberOption(request: ApplyRequest, key: string, fallback: number): number {
  const value = request.options?.[key];
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : fallback;
}

/** A yes/no option; `false`, `no`, `0` and `off` read as no. */
export function booleanOption(request: ApplyRequest, key: string, fallback: boolean): boolean {
  const value = request.options?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !/^(false|no|0|off)$/i.test(value.trim());
  return fallback;
}

/** A string option, or the fallback. */
export function stringOption(request: ApplyRequest, key: string, fallback: string): string {
  const value = request.options?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Adjusts a plan to what a target can actually do.
 *
 * Reported rather than performed silently: a dissolve that quietly became a cut
 * is a change to someone's edit, and they are entitled to see the list.
 *
 * `assets` lets the adjustments that depend on the media be made properly: a
 * still left out of a target that cannot hold one, and a clip whose speed is
 * reset re-timed against the length of its source. Without them those two are
 * made as far as the plan alone allows, never guessed.
 */
export function negotiate(
  plan: EditPlan,
  capabilities: AdapterCapabilities,
  assets?: readonly MediaAsset[],
): { plan: EditPlan; downgrades: CapabilityDowngrade[] } {
  const downgrades: CapabilityDowngrade[] = [];
  const assetOf = (id: string): MediaAsset | undefined => assets?.find((a) => a.id === id);
  const dropped = new Set<string>();

  const adjusted = plan.tracks.video.map((operation) => {
    let next = operation;

    if (!capabilities.still_images && assetOf(operation.source_asset_id)?.kind === 'image') {
      downgrades.push({
        operation_id: operation.operation_id,
        capability: 'still_images',
        action: `a still image, which ${capabilities.name} cannot hold; left out, leaving a gap`,
      });
      dropped.add(operation.operation_id);
      return next;
    }

    if (operation.speed !== 1 && !capabilities.speed_change) {
      // Setting the speed to 1 and nothing else changed the clip's length on the
      // timeline by the speed factor, and every writer then clamped it to where
      // the next clip starts: a 2x clip played the first half of its range, and
      // a 0.5x clip was cut to a third of what the plan placed. The timeline is
      // the edit, so what is kept is the clip's place on it, and the source
      // range follows.
      const onTimeline = operationTimelineDuration(operation);
      const asset = assetOf(operation.source_asset_id);
      const limit =
        asset && asset.kind !== 'image' && asset.duration_ms > 0 ? asset.duration_ms : Infinity;
      const sourceOut = Math.min(operation.source_in_ms + onTimeline, limit);
      if (sourceOut <= operation.source_in_ms) {
        downgrades.push({
          operation_id: operation.operation_id,
          capability: 'speed_change',
          action: 'cannot play at normal speed from where it starts in its source; left out',
        });
        dropped.add(operation.operation_id);
        return next;
      }
      const shortBy = onTimeline - (sourceOut - operation.source_in_ms);
      downgrades.push({
        operation_id: operation.operation_id,
        capability: 'speed_change',
        action:
          shortBy > 0
            ? `played at normal speed; its source runs out ${shortBy} ms before its place on the timeline ends, and that is left as a gap`
            : `played at normal speed for the same ${onTimeline} ms on the timeline (source out ${operation.source_out_ms} → ${sourceOut} ms)`,
      });
      next = { ...next, speed: 1, source_out_ms: sourceOut };
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

  // A clip on a track the target does not have is moved down to the highest one
  // it does — but only where that track is free. Moving without looking put a
  // V2 cutaway on top of the V1 clip it covered, and a single-track target (an
  // EDL) then held two events claiming the same frames.
  const top = capabilities.max_video_tracks - 1;
  const moved = new Map<string, number>();
  const kept = adjusted.filter((operation) => !dropped.has(operation.operation_id));
  const occupied = kept
    .filter((operation) => operation.track === top)
    .map((operation) => ({
      start: operation.timeline_start_ms,
      end: operationTimelineEnd(operation),
      id: operation.operation_id,
    }));
  const tooHigh = kept
    .filter((operation) => operation.track > top)
    .sort(
      (a, b) =>
        a.track - b.track ||
        a.timeline_start_ms - b.timeline_start_ms ||
        compareText(a.operation_id, b.operation_id),
    );
  for (const operation of tooHigh) {
    const start = operation.timeline_start_ms;
    const end = operationTimelineEnd(operation);
    const covered = occupied.find((other) => other.start < end && start < other.end);
    if (covered) {
      downgrades.push({
        operation_id: operation.operation_id,
        capability: 'max_video_tracks',
        action:
          `left out: ${capabilities.name} has ${capabilities.max_video_tracks} video track(s), ` +
          `and on track ${top} it would cover ${covered.id}`,
      });
      dropped.add(operation.operation_id);
      continue;
    }
    downgrades.push({
      operation_id: operation.operation_id,
      capability: 'max_video_tracks',
      action: `moved to track ${top}`,
    });
    moved.set(operation.operation_id, top);
    occupied.push({ start, end, id: operation.operation_id });
  }

  const video = adjusted
    .filter((operation) => !dropped.has(operation.operation_id))
    .map((operation) => {
      const track = moved.get(operation.operation_id);
      return track === undefined ? operation : { ...operation, track };
    });

  // Captions and authored text are asked about separately: a subtitle file
  // carries the first and never the second, and an interchange format may hold a
  // title and have no caption track at all. Asked together, every export of a
  // captioned plan reported the captions as "text item(s) left out".
  let text = plan.tracks.text;
  const captions = text.filter((item) => item.kind === 'caption').length;
  const authored = text.length - captions;
  if (captions > 0 && !capabilities.captions) {
    downgrades.push({
      capability: 'captions',
      action: `${captions} caption(s) left out; write them with --editor srt or --editor vtt`,
    });
    text = text.filter((item) => item.kind !== 'caption');
  }
  if (authored > 0 && !capabilities.text) {
    downgrades.push({ capability: 'text', action: `${authored} text item(s) left out` });
    text = text.filter((item) => item.kind === 'caption');
  }

  let markers = plan.markers;
  if (markers.length > 0 && !capabilities.markers) {
    downgrades.push({ capability: 'markers', action: `${markers.length} marker(s) left out` });
    markers = [];
  }

  const audio = plan.tracks.audio
    .filter((track) => {
      if (track.track < capabilities.audio_tracks) return true;
      downgrades.push({
        capability: 'audio_tracks',
        action: `audio track ${track.track} left out`,
      });
      return false;
    })
    .map((track) => {
      if (track.type !== 'external' || !track.duck_under_speech || capabilities.keyframes) {
        return track;
      }
      downgrades.push({
        capability: 'keyframes',
        action: `the bed on audio track ${track.track} is not ducked under speech; it plays at a constant ${track.gain_db} dB`,
      });
      return { ...track, duck_under_speech: false };
    });

  return { plan: { ...plan, tracks: { video, audio, text }, markers }, downgrades };
}

/** Resolves an asset id to an absolute path on disk. */
export function resolveAssetPath(request: ApplyRequest, assetId: string): string | undefined {
  const asset = request.ir.assets.find((a) => a.id === assetId);
  if (!asset) return undefined;
  return asset.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(asset.path)
    ? asset.path
    : `${request.projectRoot.replace(/\/$/, '')}/${asset.path}`;
}

/**
 * A `file://` URL, which is what every interchange format wants.
 *
 * `encodeURI` leaves the characters that delimit the parts of a URL alone,
 * which is right for a URL and wrong for a path that has to become one.
 * `#` was already handled; `?` was not, so a file called `what? really.mp4`
 * produced `file:///media/what?%20really.mp4` — a path of `/media/what` with a
 * query string after it, and a clip that imports offline. `[` and `]` belong to
 * the host part and go the same way.
 *
 * A UNC path names a machine: `\\\\server\\share\\clip.mp4` is
 * `file://server/share/clip.mp4`, with the server in the authority. Treating it
 * as an ordinary path produced `file:////server/share/clip.mp4`, which has an
 * empty authority and a path beginning with two slashes, and which resolvers
 * reject.
 */
export function toFileUrl(path: string): string {
  const normalised = path.replace(/\\/g, '/');

  const unc = /^\/\/([^/]+)(\/.*)?$/.exec(normalised);
  const host = unc ? encodeURIComponent(unc[1]!) : '';
  const rest = unc ? (unc[2] ?? '/') : normalised;
  const withLeadingSlash = rest.startsWith('/') ? rest : `/${rest}`;

  return `file://${host}${escapePath(withLeadingSlash)}`;
}

/** Percent-encodes a path, including the delimiters `encodeURI` preserves. */
function escapePath(path: string): string {
  return encodeURI(path).replace(
    /[?#[\]]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Converts milliseconds to whole frames at a rational rate. */
export function msToFrames(ms: number, rateNum: number, rateDen: number): number {
  return Math.round((ms / 1000) * (rateNum / rateDen));
}

export function framesToMs(frames: number, rateNum: number, rateDen: number): number {
  return Math.round((frames * 1000 * rateDen) / rateNum);
}

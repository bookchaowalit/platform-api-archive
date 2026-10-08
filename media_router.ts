/**
 * Media transcription decision API (solo-empire.media-route-decision.v1).
 *
 * Decides, from file metadata only, whether a video is a meeting, raw footage
 * for editing, or a content clip, and whether it is Thai, English, or unknown.
 * It then picks the speech-to-text provider and the summary profile from the
 * versioned routing registry. Provider rankings live in
 * infra/platform/media-transcription-routing.json so the "best provider right
 * now" changes by editing data and own_eval results, not code.
 *
 * The decision never sees media bytes, download URLs, or credential values;
 * provider availability is the presence of a credential variable name.
 */

import registryJson from '../platform/media-transcription-routing.json' with { type: 'json' };

export const MEDIA_ROUTE_CONTRACT = 'solo-empire.media-route-decision.v1' as const;

export type ContentKind = 'meeting' | 'video_edit' | 'video_content';
export type MediaLanguage = 'th' | 'en' | 'mixed';
export type PrivacyClass = 'public' | 'internal' | 'private' | 'restricted';

export interface OwnEval {
  evaluated_at: string;
  sample_count: number;
  /** Error rate per language in percent; lower is better. */
  wer_pct: Partial<Record<MediaLanguage, number>>;
  /** Measure behind wer_pct per language: Thai uses cer, English wer. */
  metric?: Partial<Record<MediaLanguage, 'cer' | 'wer'>>;
}

export interface ProviderPricing {
  usd_per_hour: number | null;
  free_hours_per_month: number | null;
  source: string | null;
  checked_at: string;
}

export interface ProviderEntry {
  vendor: string;
  model: string;
  credential_env: string;
  languages: MediaLanguage[];
  features: string[];
  url_input_field: string;
  pricing?: ProviderPricing;
  own_eval: OwnEval | null;
}

export interface MediaRoutingRegistry {
  schema_version: string;
  updated_at: string;
  policy: {
    max_evaluation_age_days: number;
    review_confidence_threshold: number;
    summary_privacy_class: string;
    external_privacy_classes: string[];
  };
  content_kinds: Record<ContentKind, { label: string; required_features: string[]; summary_profile: string }>;
  summary_profiles: Record<string, { gateway_route: string; prompt_version: string; gateway_profile: string; outputs: string[] }>;
  stt_routes: Record<MediaLanguage, string[]>;
  providers: Record<string, ProviderEntry>;
}

export interface MediaRouteInput {
  file_name: string;
  folder_path?: string;
  mime_type?: string;
  duration_seconds?: number;
  privacy_class?: PrivacyClass;
  hints?: { content_kind?: ContentKind; language?: MediaLanguage };
}

export interface Signal<T> {
  value: T;
  confidence: number;
  reasons: string[];
}

export interface MediaRouteDecision {
  contract: typeof MEDIA_ROUTE_CONTRACT;
  status: 'routed' | 'blocked';
  registry_updated_at: string;
  content_kind: Signal<ContentKind>;
  language: Signal<MediaLanguage | 'unknown'>;
  needs_review: boolean;
  stt: null | {
    provider_id: string;
    vendor: string;
    model: string;
    url_input_field: string;
    language_route: MediaLanguage;
    options: { diarization: boolean; word_timestamps: boolean; language_detection: boolean; language_code: MediaLanguage | null };
    selected_by: 'own_eval' | 'candidate_order';
    skipped: Array<{ provider_id: string; reason: string }>;
  };
  summary: null | { profile: string; gateway_route: string; prompt_version: string; gateway_profile: string; outputs: string[] };
  warnings: string[];
  blocked_reason?: string;
}

export class MediaRouteError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export const DEFAULT_MEDIA_ROUTING_REGISTRY = registryJson as unknown as MediaRoutingRegistry;

const CONTENT_KINDS: readonly ContentKind[] = ['meeting', 'video_edit', 'video_content'];
const LANGUAGES: readonly MediaLanguage[] = ['th', 'en', 'mixed'];
const PRIVACY_CLASSES: readonly PrivacyClass[] = ['public', 'internal', 'private', 'restricted'];
const THAI_CHARS = /[฀-๿]/;
const MAX_TEXT = 512;

// Folder rules are checked first: the folder a file is dropped into is the
// operator's explicit intent. Patterns match whole path segments.
const FOLDER_KIND_RULES: Array<[RegExp, ContentKind]> = [
  [/(^|\/)(meetings?|recordings|ประชุม)(\/|$)/i, 'meeting'],
  [/(^|\/)(edit|editing|raw|footage|ตัดต่อ)(\/|$)/i, 'video_edit'],
  [/(^|\/)(content|clips?|shorts|reels|คลิป)(\/|$)/i, 'video_content'],
];
const NAME_MEETING = /meeting recording|\bmeeting\b|\bstand-?up\b|\bweekly\b|\bsync\b|\b1on1\b|ประชุม/i;
const NAME_EDIT = /\b(raw|take|footage|a-?roll|b-?roll)\b|ตัดต่อ/i;
const NAME_CONTENT = /\b(clip|short|reel|teaser|trailer)\b|คลิป/i;
const TAG = /\[(meeting|edit|clip|th|en|mixed)\]/gi;
const FOLDER_LANG: Array<[RegExp, MediaLanguage]> = [
  [/(^|\/)(th|thai|ไทย)(\/|$)/i, 'th'],
  [/(^|\/)(en|eng|english)(\/|$)/i, 'en'],
];

function text(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new MediaRouteError(`${field} is required`, 'invalid_request');
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_TEXT || /[\u0000-\u001f]/.test(value)) {
    throw new MediaRouteError(`${field} must be a string of at most ${MAX_TEXT} printable characters`, 'invalid_request');
  }
  return value;
}

export function parseMediaRouteInput(body: unknown): MediaRouteInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MediaRouteError('Request body must be an object', 'invalid_request');
  const raw = body as Record<string, unknown>;
  const input: MediaRouteInput = { file_name: text(raw.file_name, 'file_name', true)! };
  const folder = text(raw.folder_path, 'folder_path', false);
  if (folder) input.folder_path = folder;
  const mime = text(raw.mime_type, 'mime_type', false);
  if (mime) {
    if (!/^(video|audio)\//i.test(mime)) throw new MediaRouteError('mime_type must be video/* or audio/*', 'unsupported_media_type');
    input.mime_type = mime;
  }
  if (raw.duration_seconds !== undefined) {
    const duration = raw.duration_seconds;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 86_400) {
      throw new MediaRouteError('duration_seconds must be a number between 0 and 86400', 'invalid_request');
    }
    input.duration_seconds = duration;
  }
  if (raw.privacy_class !== undefined) {
    if (!PRIVACY_CLASSES.includes(raw.privacy_class as PrivacyClass)) throw new MediaRouteError('privacy_class is invalid', 'invalid_request');
    input.privacy_class = raw.privacy_class as PrivacyClass;
  }
  if (raw.hints !== undefined) {
    if (!raw.hints || typeof raw.hints !== 'object' || Array.isArray(raw.hints)) throw new MediaRouteError('hints must be an object', 'invalid_request');
    const hints = raw.hints as Record<string, unknown>;
    input.hints = {};
    if (hints.content_kind !== undefined) {
      if (!CONTENT_KINDS.includes(hints.content_kind as ContentKind)) throw new MediaRouteError('hints.content_kind is invalid', 'invalid_request');
      input.hints.content_kind = hints.content_kind as ContentKind;
    }
    if (hints.language !== undefined) {
      if (!LANGUAGES.includes(hints.language as MediaLanguage)) throw new MediaRouteError('hints.language is invalid', 'invalid_request');
      input.hints.language = hints.language as MediaLanguage;
    }
  }
  return input;
}

function fileTags(fileName: string): Set<string> {
  return new Set([...fileName.matchAll(TAG)].map(match => match[1].toLowerCase()));
}

export function classifyContentKind(input: MediaRouteInput): Signal<ContentKind> {
  if (input.hints?.content_kind) return { value: input.hints.content_kind, confidence: 1, reasons: ['caller hint'] };
  const tags = fileTags(input.file_name);
  if (tags.has('meeting')) return { value: 'meeting', confidence: 1, reasons: ['file tag [meeting]'] };
  if (tags.has('edit')) return { value: 'video_edit', confidence: 1, reasons: ['file tag [edit]'] };
  if (tags.has('clip')) return { value: 'video_content', confidence: 1, reasons: ['file tag [clip]'] };

  const folder = (input.folder_path || '').replace(/\\/g, '/');
  for (const [pattern, kind] of FOLDER_KIND_RULES) {
    if (pattern.test(folder)) return { value: kind, confidence: 0.9, reasons: [`folder matches ${kind}`] };
  }
  if (NAME_MEETING.test(input.file_name)) return { value: 'meeting', confidence: 0.75, reasons: ['file name looks like a meeting'] };
  if (NAME_EDIT.test(input.file_name)) return { value: 'video_edit', confidence: 0.7, reasons: ['file name looks like raw footage'] };
  if (NAME_CONTENT.test(input.file_name)) return { value: 'video_content', confidence: 0.7, reasons: ['file name looks like a clip'] };

  const duration = input.duration_seconds;
  if (duration !== undefined && duration >= 20 * 60) return { value: 'meeting', confidence: 0.55, reasons: ['long recording (>= 20 min) with no other signal'] };
  if (duration !== undefined && duration <= 3 * 60) return { value: 'video_content', confidence: 0.55, reasons: ['short recording (<= 3 min) with no other signal'] };
  return { value: 'video_content', confidence: 0.3, reasons: ['no signal; defaulted to video_content'] };
}

export function detectLanguage(input: MediaRouteInput): Signal<MediaLanguage | 'unknown'> {
  if (input.hints?.language) return { value: input.hints.language, confidence: 1, reasons: ['caller hint'] };
  const tags = fileTags(input.file_name);
  for (const language of LANGUAGES) {
    if (tags.has(language)) return { value: language, confidence: 1, reasons: [`file tag [${language}]`] };
  }
  const folder = (input.folder_path || '').replace(/\\/g, '/');
  for (const [pattern, language] of FOLDER_LANG) {
    if (pattern.test(folder)) return { value: language, confidence: 0.9, reasons: [`folder matches ${language}`] };
  }
  if (THAI_CHARS.test(input.file_name) || THAI_CHARS.test(folder)) {
    return { value: 'th', confidence: 0.6, reasons: ['Thai characters in file or folder name'] };
  }
  return { value: 'unknown', confidence: 0, reasons: ['no language signal; provider language detection will decide'] };
}

function evaluationAgeDays(evaluatedAt: string, now: Date): number | null {
  const time = Date.parse(evaluatedAt);
  return Number.isFinite(time) ? Math.floor((now.getTime() - time) / 86_400_000) : null;
}

export interface MediaRouteOptions {
  registry?: MediaRoutingRegistry;
  /** Environment used only to test credential variable presence. */
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export function decideMediaRoute(input: MediaRouteInput, options: MediaRouteOptions = {}): MediaRouteDecision {
  const registry = options.registry ?? DEFAULT_MEDIA_ROUTING_REGISTRY;
  const env = options.env ?? {};
  const now = options.now ?? new Date();
  const contentKind = classifyContentKind(input);
  const language = detectLanguage(input);
  const warnings: string[] = [];
  const threshold = registry.policy.review_confidence_threshold;
  const needsReview = contentKind.confidence < threshold;
  const base = {
    contract: MEDIA_ROUTE_CONTRACT,
    registry_updated_at: registry.updated_at,
    content_kind: contentKind,
    language,
    needs_review: needsReview,
  };

  const privacy = input.privacy_class ?? (contentKind.value === 'meeting' ? 'internal' : 'public');
  if (!registry.policy.external_privacy_classes.includes(privacy)) {
    return {
      ...base,
      status: 'blocked',
      stt: null,
      summary: null,
      warnings,
      blocked_reason: `privacy_class ${privacy} may not leave for an external transcription provider`,
    };
  }

  const kind = registry.content_kinds[contentKind.value];
  const route: MediaLanguage = language.value === 'unknown' ? 'mixed' : language.value;
  const skipped: Array<{ provider_id: string; reason: string }> = [];
  const eligible: Array<{ id: string; provider: ProviderEntry; order: number; wer: number | null }> = [];

  (registry.stt_routes[route] || []).forEach((id, order) => {
    const provider = registry.providers[id];
    if (!provider) return skipped.push({ provider_id: id, reason: 'not in registry' });
    if (!provider.languages.includes(route)) return skipped.push({ provider_id: id, reason: `no ${route} support` });
    const missing = kind.required_features.filter(feature => !provider.features.includes(feature));
    if (missing.length) return skipped.push({ provider_id: id, reason: `missing ${missing.join(', ')}` });
    if (!(env[provider.credential_env] || '').trim()) return skipped.push({ provider_id: id, reason: `${provider.credential_env} not set` });
    let wer: number | null = null;
    if (provider.own_eval) {
      const age = evaluationAgeDays(provider.own_eval.evaluated_at, now);
      const value = provider.own_eval.wer_pct[route];
      if (age !== null && age <= registry.policy.max_evaluation_age_days && typeof value === 'number') wer = value;
      else if (age !== null && age > registry.policy.max_evaluation_age_days) warnings.push(`${id} own_eval is ${age} days old; re-evaluate`);
    }
    eligible.push({ id, provider, order, wer });
  });

  if (!eligible.length) {
    return {
      ...base,
      status: 'blocked',
      stt: null,
      summary: null,
      warnings,
      blocked_reason: `no configured ${route} transcription provider satisfies ${kind.required_features.join(', ')}`,
    };
  }

  const anyMeasured = eligible.some(candidate => candidate.wer !== null);
  if (!anyMeasured) warnings.push(`no fresh own_eval for ${route}; using candidate order from public evidence`);
  eligible.sort((a, b) => {
    if (a.wer !== null && b.wer !== null) return a.wer - b.wer || a.order - b.order;
    if (a.wer !== null) return -1;
    if (b.wer !== null) return 1;
    return a.order - b.order;
  });
  const chosen = eligible[0];
  for (const other of eligible.slice(1)) skipped.push({ provider_id: other.id, reason: `ranked below ${chosen.id}` });

  const profile = registry.summary_profiles[kind.summary_profile];
  return {
    ...base,
    status: 'routed',
    stt: {
      provider_id: chosen.id,
      vendor: chosen.provider.vendor,
      model: chosen.provider.model,
      url_input_field: chosen.provider.url_input_field,
      language_route: route,
      options: {
        diarization: contentKind.value === 'meeting',
        word_timestamps: true,
        language_detection: route === 'mixed',
        language_code: route === 'mixed' ? null : route,
      },
      selected_by: chosen.wer !== null ? 'own_eval' : 'candidate_order',
      skipped,
    },
    summary: { profile: kind.summary_profile, ...profile },
    warnings,
  };
}

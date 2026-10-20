import type { OpsOptions, ParseOptions, Quality, StepInput } from './types.js';

/**
 * The single mapping from user options to task params. Each function serves one task type;
 * the route table refers to them by name and never computes params itself.
 */

type Params = Record<string, unknown>;

/** `quality` is a (long edge, encoding) preset; the tiered value is for tasks that take fixed sizes. */
const QUALITY: Record<Quality, { tiered: number; free: number; encoding: 'png' | 'jpg' }> = {
  low: { tiered: 1080, free: 1080, encoding: 'jpg' },
  medium: { tiered: 1920, free: 1600, encoding: 'png' },
  high: { tiered: 2560, free: 2560, encoding: 'png' },
};

/** `convertor.ppt2image` only accepts these long edges. */
const PPT_RESOLUTIONS = [1080, 1920, 2560];
const PPT_BASE = 1920;
const PDF_BASE = 1080;

export function none(): Params {
  return {};
}

export function ppt2image(options: OpsOptions, _input: StepInput, warnings: string[]): Params {
  const requested = longEdge(options, PPT_BASE, 'tiered');
  let resolution: number | undefined;
  if (requested !== undefined) {
    resolution = nearest(requested, PPT_RESOLUTIONS);
    if (resolution !== requested) {
      warnings.push(`Resolution ${requested} was snapped to ${resolution}: PPTX renders at ${PPT_RESOLUTIONS.join('/')} only.`);
    }
  }
  return { ...(resolution !== undefined ? { resolution } : {}), format: encoding(options) };
}

export function pdf2image(options: OpsOptions): Params {
  const resolution = longEdge(options, PDF_BASE, 'free');
  return { ...(resolution !== undefined ? { resolution } : {}), format: encoding(options) };
}

/** A URL input is rendered from `key`, which the task accepts as an http(s) address. */
export function html2png(options: OpsOptions, input: StepInput): Params {
  return {
    ...(input.url !== undefined ? { key: input.url } : {}),
    fullPage: true,
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.width !== undefined ? { width: options.width } : {}),
  };
}

export function markdown2png(options: OpsOptions): Params {
  return {
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.width !== undefined ? { pageWidth: options.width } : {}),
  };
}

export function documentConvert(options: OpsOptions, input: StepInput): Params {
  return {
    to: 'markdown',
    ...(options.anchors !== undefined ? { anchors: options.anchors } : {}),
    ...(options.splitPages !== undefined ? { splitPages: options.splitPages } : {}),
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...parse(options),
  };
}

export function documentExtract(options: OpsOptions, input: StepInput): Params {
  return {
    to: options.to,
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...parse(options),
  };
}

function parse(options: ParseOptions): { parse?: ParseOptions } {
  const picked: ParseOptions = {
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.includeImages !== undefined ? { includeImages: options.includeImages } : {}),
    ...(options.stayImageAreaRate !== undefined ? { stayImageAreaRate: options.stayImageAreaRate } : {}),
  };
  return Object.keys(picked).length ? { parse: picked } : {};
}

/** The backend encoding. `webp` is produced by a trailing conversion, so the render itself is PNG. */
function encoding(options: OpsOptions): 'png' | 'jpg' {
  if (options.imageFormat === 'jpg') return 'jpg';
  if (options.imageFormat === 'png' || options.imageFormat === 'webp') return 'png';
  return options.quality ? QUALITY[options.quality].encoding : 'png';
}

/** `width` wins over `scale` (a multiple of the task's base), which wins over `quality`. */
function longEdge(options: OpsOptions, base: number, kind: 'tiered' | 'free'): number | undefined {
  if (options.width !== undefined) return options.width;
  if (options.scale !== undefined) return Math.round(base * options.scale);
  if (options.quality) return QUALITY[options.quality][kind];
  return undefined;
}

/** Nearest allowed value; ties go to the larger one. */
function nearest(value: number, allowed: readonly number[]): number {
  let best = allowed[0]!;
  for (const candidate of allowed) {
    const distance = Math.abs(candidate - value);
    const bestDistance = Math.abs(best - value);
    if (distance < bestDistance || (distance === bestDistance && candidate > best)) best = candidate;
  }
  return best;
}

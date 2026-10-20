import { DeckOpsError } from '../errors/index.js';
import { EXTENSIONS, OPTION_FAMILIES, ROUTES, WEBP_STEP } from './routes.js';
import type { InputFamily, OpsOptions, OptionName, Route, Step, Target, Verb } from './types.js';

export interface Plan {
  route: Route;
  steps: readonly Step[];
  warnings: string[];
}

/** Lower-case extension of a file name or path, with the dot; '' when there is none. */
export function extensionOf(name: string): string {
  const base = (name.split(/[?#]/)[0] ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function familyOf(name: string): Exclude<InputFamily, 'url'> | undefined {
  return EXTENSIONS[extensionOf(name)];
}

export function findRoute(verb: Verb, family: InputFamily, to: Target): Route | undefined {
  return ROUTES.find((route) => route.verb === verb && route.to === to && route.from.includes(family));
}

/** Pick the route for an input and check every option against it before anything is uploaded. */
export function planRoute(verb: Verb, family: InputFamily | undefined, source: string, options: OpsOptions): Plan {
  if (family === undefined) throw unknownInput(verb, source);
  const route = findRoute(verb, family, options.to);
  if (!route) throw unsupportedRoute(verb, family, options.to);

  for (const name of Object.keys(options) as (keyof OpsOptions)[]) {
    if (name === 'to' || options[name] === undefined) continue;
    if (!route.options.includes(name)) {
      throw DeckOpsError.usage(`${name} does not apply to ${verb} ${label(family)} → ${options.to}.`);
    }
    const families = OPTION_FAMILIES[name as OptionName];
    if (families && !families.includes(family)) {
      throw DeckOpsError.usage(`${name} only applies to ${families.map(label).join('/')} input, not ${label(family)}.`);
    }
  }
  if (options.imageFormat !== undefined && !route.imageFormats?.includes(options.imageFormat)) {
    throw DeckOpsError.usage(
      `imageFormat ${options.imageFormat} is not available for ${label(family)}.`,
      { hint: `Choose ${(route.imageFormats ?? []).join(', ') || 'no format'}.` },
    );
  }
  const steps = options.to === 'image' && options.imageFormat === 'webp' ? [...route.steps, WEBP_STEP] : route.steps;
  return { route, steps, warnings: route.caveat ? [route.caveat] : [] };
}

/** Verb → target → input families, from the table. Feeds `deckops formats` and error hints. */
export function matrix(): { verb: Verb; to: Target; from: InputFamily[] }[] {
  const rows: { verb: Verb; to: Target; from: InputFamily[] }[] = [];
  for (const route of ROUTES) {
    const row = rows.find((item) => item.verb === route.verb && item.to === route.to);
    if (row) row.from.push(...route.from.filter((family) => !row.from.includes(family)));
    else rows.push({ verb: route.verb, to: route.to, from: [...route.from] });
  }
  return rows;
}

function unknownInput(verb: Verb, source: string): DeckOpsError {
  const extension = extensionOf(source);
  const accepted = [...new Set(ROUTES.filter((route) => route.verb === verb).flatMap((route) => route.from))];
  return DeckOpsError.unsupported(
    extension ? `${extension} files are not supported.` : `Cannot tell the format of "${source}".`,
    { hint: `${verb} accepts ${accepted.map(label).join(', ')}.` },
  );
}

/** Name the closest combinations that do exist: other targets for this input, other inputs for this target. */
function unsupportedRoute(verb: Verb, family: InputFamily, to: Target): DeckOpsError {
  const targets = ROUTES.filter((route) => route.verb === verb && route.from.includes(family)).map((route) => route.to);
  const families = [...new Set(ROUTES.filter((route) => route.verb === verb && route.to === to).flatMap((route) => route.from))];
  const others = matrix().filter((row) => row.verb !== verb && row.from.includes(family)).map((row) => `${row.verb} --to ${row.to}`);
  const nearest = [
    targets.length ? `${label(family)} can ${verb} to ${[...new Set(targets)].join(', ')}` : '',
    families.length ? `${to} comes from ${families.map(label).join(', ')}` : '',
    !targets.length && others.length ? `${label(family)} supports ${others.join(', ')}` : '',
  ].filter(Boolean);
  return DeckOpsError.unsupported(
    `${verb} cannot turn ${label(family)} into ${to}.`,
    nearest.length ? { hint: `${nearest.join('; ')}.` } : {},
  );
}

function label(family: InputFamily): string {
  return family === 'url' ? 'URLs' : `.${family}`;
}

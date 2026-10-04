/**
 * Read model for the shared building-block services catalog.
 *
 * Every Solo Empire app asks this route which central gateway, SDK, edge rule,
 * or platform binding provides a capability (auth, email, payments, KYC, ...)
 * instead of wiring its own provider. The source of truth and its validator are
 * infra/platform/building-block-services.yaml and
 * infra/scripts/platform/building_block_services.py; this module only reads.
 */
import { readFileSync } from 'fs';
import { fileURLToPath, URL } from 'url';
import { parse as parseYaml } from 'yaml';

export const BUILDING_BLOCK_CATALOG_PATH = fileURLToPath(
  new URL('../platform/building-block-services.yaml', import.meta.url),
);

export type BuildingBlockDecision = 'build' | 'hybrid' | 'buy';

export interface BuildingBlockService {
  id: string;
  category: string;
  name: string;
  decision: BuildingBlockDecision;
  difficulty: number;
  primary: string;
  alternatives: string[];
  refs: string[];
  status: 'live' | 'partial' | 'planned' | 'deferred';
  phase: 'now' | 'next' | 'later' | 'on_demand';
  data_class: string;
  approval: boolean;
  contract?: string;
  impl: string[];
  note?: string;
  access: string;
  gateway: string | null;
}

interface BuildingBlockCategory {
  id: string;
  name: string;
  gateway: string | null;
  access: string;
}

interface BuildingBlockCatalog {
  schema_version: string;
  updated: string;
  policy: Record<string, unknown>;
  defaults: Record<string, unknown>;
  categories: BuildingBlockCategory[];
  services: Array<Partial<BuildingBlockService>>;
}

export const BUILDING_BLOCK_FILTERS = ['id', 'category', 'decision', 'status', 'phase'] as const;
export type BuildingBlockFilter = Partial<Record<(typeof BUILDING_BLOCK_FILTERS)[number], string>>;

let cached: BuildingBlockCatalog | null = null;

export function loadBuildingBlockCatalog(path = BUILDING_BLOCK_CATALOG_PATH): BuildingBlockCatalog {
  if (path === BUILDING_BLOCK_CATALOG_PATH && cached) return cached;
  const catalog = parseYaml(readFileSync(path, 'utf8')) as BuildingBlockCatalog;
  if (path === BUILDING_BLOCK_CATALOG_PATH) cached = catalog;
  return catalog;
}

/** Apply catalog defaults and attach each category's access mode and gateway prefix. */
export function resolveBuildingBlocks(catalog: BuildingBlockCatalog): BuildingBlockService[] {
  const categories = new Map(catalog.categories.map((category) => [category.id, category]));
  return catalog.services.map((service) => {
    const category = categories.get(service.category || '');
    return {
      ...catalog.defaults,
      refs: [],
      impl: [],
      ...service,
      access: category?.access || 'gateway',
      gateway: category?.gateway ?? null,
    } as BuildingBlockService;
  });
}

export function buildingBlocksResponse(filter: BuildingBlockFilter, catalog = loadBuildingBlockCatalog()) {
  let services = resolveBuildingBlocks(catalog);
  for (const key of BUILDING_BLOCK_FILTERS) {
    const value = filter[key];
    if (value) services = services.filter((service) => service[key] === value);
  }
  const count = (field: 'decision' | 'status' | 'phase') =>
    services.reduce((counts: Record<string, number>, service) => {
      counts[service[field]] = (counts[service[field]] || 0) + 1;
      return counts;
    }, {});
  return {
    source: 'infra/platform/building-block-services.yaml',
    schema_version: catalog.schema_version,
    updated: catalog.updated,
    policy: catalog.policy,
    categories: catalog.categories,
    total: services.length,
    decision_counts: count('decision'),
    status_counts: count('status'),
    phase_counts: count('phase'),
    services,
  };
}

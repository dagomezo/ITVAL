import "server-only";

import fs from "node:fs";
import path from "node:path";
import { isDatabaseEnabled, query } from "@/lib/db/pool";
import { MANIFEST_PATHS, readJsonFile, writeJsonFile } from "./manifests";
import {
  APPLICATION_KEYS,
  MATERIAL_KEYS,
  PRIMARY_GROUPS,
  SECTOR_KEYS,
  SYSTEM_KEYS,
} from "@/lib/catalog/filter-keys";

const root = process.cwd();
const CATALOG_ES = path.join(root, "messages/products-catalog/es.json");
const CATALOG_EN = path.join(root, "messages/products-catalog/en.json");
const PLACEHOLDER_IMAGE = "/images/pages/products.svg";

type Taxonomy = Record<string, string[]>;

type CatalogFile = {
  categories: Record<string, { title: string; description: string }>;
  subcategories: Record<string, Record<string, Record<string, unknown>>>;
};

type SubcategoryContent = {
  title: string;
  description: string;
  applications: { i1: string; i2: string; i3: string };
  benefits: { i1: string; i2: string; i3: string };
  materials: string;
  standards: string;
  options: string;
};

export type CatalogFilterSelection = {
  primaryGroup: string;
  sectors: string[];
  materials: string[];
  systems: string[];
  applications: string[];
};

type FilterConfigEntry = Partial<CatalogFilterSelection> & { tags?: string[] };

type FilterConfigFile = {
  categories: Record<string, FilterConfigEntry>;
  subcategories: Record<string, Record<string, FilterConfigEntry>>;
};

const DEFAULT_FILTERS: CatalogFilterSelection = {
  primaryGroup: "other",
  sectors: ["corporate", "commercial", "institutional"],
  materials: ["aluminum", "temperedGlass", "laminatedGlass"],
  systems: ["structural"],
  applications: ["facade"],
};

function readFilterConfig(): FilterConfigFile {
  const data = readJsonFile<Partial<FilterConfigFile>>(MANIFEST_PATHS.filters);
  return {
    categories: data.categories ?? {},
    subcategories: data.subcategories ?? {},
  };
}

function writeFilterConfig(data: FilterConfigFile): void {
  writeJsonFile(MANIFEST_PATHS.filters, data);
}

function keepKnown(values: string[] | undefined, known: readonly string[]): string[] | undefined {
  if (!values) return undefined;
  const valid = values.filter((value) => known.includes(value));
  return valid.length > 0 ? valid : undefined;
}

function resolveFilters(
  base: FilterConfigEntry | undefined,
  override?: FilterConfigEntry,
): CatalogFilterSelection {
  const primaryCandidates = PRIMARY_GROUPS.filter((g) => g !== "all") as readonly string[];
  const pick = (value: string | undefined) =>
    value && primaryCandidates.includes(value) ? value : undefined;

  return {
    primaryGroup:
      pick(override?.primaryGroup) ?? pick(base?.primaryGroup) ?? DEFAULT_FILTERS.primaryGroup,
    sectors:
      keepKnown(override?.sectors, SECTOR_KEYS) ??
      keepKnown(base?.sectors, SECTOR_KEYS) ??
      DEFAULT_FILTERS.sectors,
    materials:
      keepKnown(override?.materials, MATERIAL_KEYS) ??
      keepKnown(base?.materials, MATERIAL_KEYS) ??
      DEFAULT_FILTERS.materials,
    systems:
      keepKnown(override?.systems, SYSTEM_KEYS) ??
      keepKnown(base?.systems, SYSTEM_KEYS) ??
      DEFAULT_FILTERS.systems,
    applications:
      keepKnown(override?.applications, APPLICATION_KEYS) ??
      keepKnown(base?.applications, APPLICATION_KEYS) ??
      DEFAULT_FILTERS.applications,
  };
}

export type CatalogFilterOptions = {
  primaryGroups: { value: string; label: string }[];
  sectors: { value: string; label: string }[];
  materials: { value: string; label: string }[];
  systems: { value: string; label: string }[];
  applications: { value: string; label: string }[];
};

/** Opciones de filtros con etiquetas en español, leídas del mismo i18n que ve el sitio. */
export function listCatalogFilterOptions(): CatalogFilterOptions {
  const explorer = (readFullCatalog("es").explorer ?? {}) as Record<
    string,
    Record<string, string>
  >;

  const withLabels = (
    keys: readonly string[],
    section: string,
  ): { value: string; label: string }[] =>
    keys.map((key) => ({ value: key, label: explorer[section]?.[key] ?? key }));

  return {
    primaryGroups: withLabels(
      PRIMARY_GROUPS.filter((g) => g !== "all"),
      "primary",
    ),
    sectors: withLabels(SECTOR_KEYS, "sectors"),
    materials: withLabels(MATERIAL_KEYS, "materials"),
    systems: withLabels(SYSTEM_KEYS, "systems"),
    applications: withLabels(APPLICATION_KEYS, "applications"),
  };
}

export async function updateCatalogFilters(patch: {
  type: "category" | "subcategory";
  categoryKey: string;
  subcategoryKey?: string;
  filters: Partial<CatalogFilterSelection>;
}): Promise<void> {
  const config = readFilterConfig();
  const clean: FilterConfigEntry = {};

  const primaryCandidates = PRIMARY_GROUPS.filter((g) => g !== "all") as readonly string[];
  if (patch.filters.primaryGroup && primaryCandidates.includes(patch.filters.primaryGroup)) {
    clean.primaryGroup = patch.filters.primaryGroup;
  }
  const sectors = keepKnown(patch.filters.sectors, SECTOR_KEYS);
  const materials = keepKnown(patch.filters.materials, MATERIAL_KEYS);
  const systems = keepKnown(patch.filters.systems, SYSTEM_KEYS);
  const applications = keepKnown(patch.filters.applications, APPLICATION_KEYS);
  if (sectors) clean.sectors = sectors;
  if (materials) clean.materials = materials;
  if (systems) clean.systems = systems;
  if (applications) clean.applications = applications;

  if (patch.type === "category") {
    config.categories[patch.categoryKey] = {
      ...config.categories[patch.categoryKey],
      ...clean,
    };
  } else {
    if (!patch.subcategoryKey) throw new Error("Subcategoría requerida.");
    config.subcategories[patch.categoryKey] ??= {};
    config.subcategories[patch.categoryKey][patch.subcategoryKey] = {
      ...config.subcategories[patch.categoryKey][patch.subcategoryKey],
      ...clean,
    };
  }

  writeFilterConfig(config);
}

function readTaxonomy(): Taxonomy {
  return readJsonFile<Taxonomy>(MANIFEST_PATHS.taxonomy);
}

function writeTaxonomy(data: Taxonomy): void {
  writeJsonFile(MANIFEST_PATHS.taxonomy, data);
}

export function suggestCatalogKey(label: string): string {
  const words = label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return "nuevaCategoria";

  const key = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");

  return key.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "nuevaCategoria";
}

function validateKey(key: string): void {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) {
    throw new Error(
      "El código debe empezar en minúscula y usar solo letras y números (ej: nuevaLinea).",
    );
  }
}

function buildSubcategoryContent(
  title: string,
  description: string,
  locale: "es" | "en",
): SubcategoryContent {
  if (locale === "en") {
    return {
      title,
      description:
        description ||
        `${title}: ITVAL aluminum and glass solution with engineering, fabrication and certified installation.`,
      applications: {
        i1: "Corporate and commercial buildings",
        i2: "Institutional projects",
        i3: "Premium developments",
      },
      benefits: {
        i1: "Proven technical performance and durability",
        i2: "Architectural aesthetics and brand value",
        i3: "End-to-end support from quote to installation",
      },
      materials: "Aluminum, laminated/tempered glass, steel and hardware per specification.",
      standards: "NEC, ASTM, ASCE, AISC, AISI, Aluminum Design Manual.",
      options: "Custom finishes, dimensions and glass configurations per project.",
    };
  }

  return {
    title,
    description:
      description ||
      `${title}: solución ITVAL en aluminio y vidrio con ingeniería, fabricación e instalación certificada.`,
    applications: {
      i1: "Edificios corporativos y comerciales",
      i2: "Proyectos institucionales",
      i3: "Desarrollos residenciales premium",
    },
    benefits: {
      i1: "Desempeño técnico y durabilidad comprobada",
      i2: "Estética arquitectónica y valor de marca",
      i3: "Acompañamiento integral desde cotización a instalación",
    },
    materials: "Aluminio, vidrio laminado/templado, acero y herrajes según especificación.",
    standards: "NEC, ASTM, ASCE, AISC, AISI, Aluminum Design Manual.",
    options: "Acabados, dimensiones y configuraciones personalizadas según proyecto.",
  };
}

function readFullCatalog(locale: "es" | "en"): Record<string, unknown> {
  const filePath = locale === "es" ? CATALOG_ES : CATALOG_EN;
  return readJsonFile<Record<string, unknown>>(filePath);
}

function writeFullCatalog(locale: "es" | "en", data: Record<string, unknown>): void {
  const filePath = locale === "es" ? CATALOG_ES : CATALOG_EN;
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function updateProductImages(
  categoryKey: string,
  subcategoryKey?: string,
): void {
  const products = readJsonFile<{
    categories?: Record<string, string>;
    subcategories?: Record<string, Record<string, string>>;
    galleries?: Record<string, Record<string, unknown[]>>;
  }>(MANIFEST_PATHS.products);

  products.categories ??= {};
  products.subcategories ??= {};
  products.galleries ??= {};

  if (!products.categories[categoryKey]) {
    products.categories[categoryKey] = PLACEHOLDER_IMAGE;
  }

  if (subcategoryKey) {
    products.subcategories[categoryKey] ??= {};
    products.galleries[categoryKey] ??= {};
    if (!products.subcategories[categoryKey][subcategoryKey]) {
      products.subcategories[categoryKey][subcategoryKey] = PLACEHOLDER_IMAGE;
    }
    products.galleries[categoryKey][subcategoryKey] ??= [];
  }

  writeJsonFile(MANIFEST_PATHS.products, products);
}

export type CatalogSubcategoryItem = {
  key: string;
  categoryKey: string;
  titleEs: string;
  titleEn: string;
  descriptionEs: string;
  descriptionEn: string;
  imageCount: number;
  heroSrc: string | null;
  filters: CatalogFilterSelection;
};

export type CatalogCategoryItem = {
  key: string;
  titleEs: string;
  titleEn: string;
  descriptionEs: string;
  descriptionEn: string;
  imageCount: number;
  heroSrc: string | null;
  filters: CatalogFilterSelection;
  subcategories: CatalogSubcategoryItem[];
};

function readCatalog(locale: "es" | "en"): {
  categories: Record<string, { title: string; description: string }>;
  subcategories: Record<string, Record<string, { title: string; description: string }>>;
} {
  const full = readFullCatalog(locale);
  return {
    categories: (full.categories ?? {}) as Record<string, { title: string; description: string }>,
    subcategories: (full.subcategories ?? {}) as Record<
      string,
      Record<string, { title: string; description: string }>
    >,
  };
}

function writeCatalog(locale: "es" | "en", data: {
  categories: Record<string, { title: string; description: string }>;
  subcategories: Record<string, Record<string, { title: string; description: string }>>;
}): void {
  const existing = readFullCatalog(locale);
  writeFullCatalog(locale, {
    ...existing,
    categories: data.categories,
    subcategories: {
      ...(existing.subcategories as Record<string, unknown>),
      ...data.subcategories,
    },
  });
}

async function loadImageCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (isDatabaseEnabled()) {
    const { rows } = await query<{ category: string; subcategory: string; count: string }>(
      `SELECT category, subcategory, COUNT(*)::text AS count
       FROM product_gallery_images GROUP BY category, subcategory`,
    );
    for (const row of rows) {
      counts.set(`${row.category}/${row.subcategory}`, Number.parseInt(row.count, 10));
    }
    return counts;
  }

  const products = readJsonFile<{
    galleries?: Record<string, Record<string, unknown[]>>;
  }>(MANIFEST_PATHS.products);

  for (const [category, subs] of Object.entries(products.galleries ?? {})) {
    for (const [subcategory, images] of Object.entries(subs)) {
      counts.set(`${category}/${subcategory}`, images.length);
    }
  }
  return counts;
}

function loadHeroImages(): {
  categories: Record<string, string>;
  subcategories: Record<string, Record<string, string>>;
} {
  const products = readJsonFile<{
    categories?: Record<string, string>;
    subcategories?: Record<string, Record<string, string>>;
  }>(MANIFEST_PATHS.products);
  return {
    categories: products.categories ?? {},
    subcategories: products.subcategories ?? {},
  };
}

export async function listCatalogTree(): Promise<CatalogCategoryItem[]> {
  const es = readCatalog("es");
  const en = readCatalog("en");
  const imageCounts = await loadImageCounts();
  const heroes = loadHeroImages();

  const tax = readTaxonomy();
  const filterConfig = readFilterConfig();

  return Object.entries(tax).map(([categoryKey, subs]) => {
    const subcategoryKeys = subs as string[];
    const categoryFilters = filterConfig.categories[categoryKey];
    const subcategories: CatalogSubcategoryItem[] = subcategoryKeys.map((subKey) => ({
      key: subKey,
      categoryKey,
      titleEs: es.subcategories[categoryKey]?.[subKey]?.title ?? subKey,
      titleEn: en.subcategories[categoryKey]?.[subKey]?.title ?? subKey,
      descriptionEs: es.subcategories[categoryKey]?.[subKey]?.description ?? "",
      descriptionEn: en.subcategories[categoryKey]?.[subKey]?.description ?? "",
      imageCount: imageCounts.get(`${categoryKey}/${subKey}`) ?? 0,
      heroSrc: heroes.subcategories[categoryKey]?.[subKey] ?? null,
      filters: resolveFilters(
        categoryFilters,
        filterConfig.subcategories[categoryKey]?.[subKey],
      ),
    }));

    const categoryImageCount = subcategories.reduce((sum, sub) => sum + sub.imageCount, 0);

    return {
      key: categoryKey,
      titleEs: es.categories[categoryKey]?.title ?? categoryKey,
      titleEn: en.categories[categoryKey]?.title ?? categoryKey,
      descriptionEs: es.categories[categoryKey]?.description ?? "",
      descriptionEn: en.categories[categoryKey]?.description ?? "",
      imageCount: categoryImageCount,
      heroSrc: heroes.categories[categoryKey] ?? null,
      filters: resolveFilters(categoryFilters),
      subcategories,
    };
  });
}

export async function updateCatalogEntry(patch: {
  type: "category" | "subcategory";
  categoryKey: string;
  subcategoryKey?: string;
  titleEs?: string;
  titleEn?: string;
  descriptionEs?: string;
  descriptionEn?: string;
}): Promise<void> {
  const es = readCatalog("es");
  const en = readCatalog("en");

  if (patch.type === "category") {
    es.categories[patch.categoryKey] ??= { title: "", description: "" };
    en.categories[patch.categoryKey] ??= { title: "", description: "" };
    if (patch.titleEs != null) es.categories[patch.categoryKey].title = patch.titleEs.trim();
    if (patch.titleEn != null) en.categories[patch.categoryKey].title = patch.titleEn.trim();
    if (patch.descriptionEs != null) {
      es.categories[patch.categoryKey].description = patch.descriptionEs.trim();
    }
    if (patch.descriptionEn != null) {
      en.categories[patch.categoryKey].description = patch.descriptionEn.trim();
    }
  } else {
    if (!patch.subcategoryKey) throw new Error("Subcategoría requerida.");
    es.subcategories[patch.categoryKey] ??= {};
    en.subcategories[patch.categoryKey] ??= {};
    es.subcategories[patch.categoryKey][patch.subcategoryKey] ??= { title: "", description: "" };
    en.subcategories[patch.categoryKey][patch.subcategoryKey] ??= { title: "", description: "" };

    const esSub = es.subcategories[patch.categoryKey][patch.subcategoryKey];
    const enSub = en.subcategories[patch.categoryKey][patch.subcategoryKey];

    if (patch.titleEs != null) esSub.title = patch.titleEs.trim();
    if (patch.titleEn != null) enSub.title = patch.titleEn.trim();
    if (patch.descriptionEs != null) esSub.description = patch.descriptionEs.trim();
    if (patch.descriptionEn != null) enSub.description = patch.descriptionEn.trim();
  }

  writeCatalog("es", es);
  writeCatalog("en", en);
}

export function listProjectCategoryOptions(): { value: string; label: string }[] {
  const es = readCatalog("es");
  return Object.keys(readTaxonomy()).map((key) => ({
    value: key,
    label: es.categories[key]?.title ?? key,
  }));
}

export async function addCategory(input: {
  key: string;
  titleEs: string;
  titleEn: string;
  descriptionEs: string;
  descriptionEn: string;
  subcategoryKey: string;
  subTitleEs: string;
  subTitleEn: string;
  subDescriptionEs?: string;
  subDescriptionEn?: string;
  primaryGroup?: string;
}): Promise<void> {
  const key = input.key.trim();
  validateKey(key);

  const tax = readTaxonomy();
  if (tax[key]) throw new Error("Ya existe una categoría con ese código.");

  const subKey = input.subcategoryKey.trim();
  validateKey(subKey);

  tax[key] = [subKey];
  writeTaxonomy(tax);

  for (const locale of ["es", "en"] as const) {
    const full = readFullCatalog(locale);
    const categories = (full.categories ?? {}) as Record<string, { title: string; description: string }>;
    const subcategories = (full.subcategories ?? {}) as Record<string, Record<string, unknown>>;

    categories[key] = {
      title: locale === "es" ? input.titleEs.trim() : input.titleEn.trim(),
      description:
        locale === "es" ? input.descriptionEs.trim() : input.descriptionEn.trim(),
    };

    subcategories[key] ??= {};
    subcategories[key][subKey] = buildSubcategoryContent(
      locale === "es" ? input.subTitleEs.trim() : input.subTitleEn.trim(),
      locale === "es" ? (input.subDescriptionEs ?? "") : (input.subDescriptionEn ?? ""),
      locale,
    );

    writeFullCatalog(locale, { ...full, categories, subcategories });
  }

  const filterConfig = readFilterConfig();
  const primaryCandidates = PRIMARY_GROUPS.filter((g) => g !== "all") as readonly string[];
  filterConfig.categories[key] = {
    ...DEFAULT_FILTERS,
    primaryGroup:
      input.primaryGroup && primaryCandidates.includes(input.primaryGroup)
        ? input.primaryGroup
        : DEFAULT_FILTERS.primaryGroup,
  };
  writeFilterConfig(filterConfig);

  updateProductImages(key, subKey);
}

export async function addSubcategory(input: {
  categoryKey: string;
  key: string;
  titleEs: string;
  titleEn: string;
  descriptionEs?: string;
  descriptionEn?: string;
}): Promise<void> {
  const categoryKey = input.categoryKey.trim();
  const subKey = input.key.trim();
  validateKey(subKey);

  const tax = readTaxonomy();
  if (!tax[categoryKey]) throw new Error("Categoría no encontrada.");
  if (tax[categoryKey].includes(subKey)) throw new Error("Ya existe esa subcategoría.");

  tax[categoryKey] = [...tax[categoryKey], subKey];
  writeTaxonomy(tax);

  for (const locale of ["es", "en"] as const) {
    const full = readFullCatalog(locale);
    const subcategories = (full.subcategories ?? {}) as Record<string, Record<string, unknown>>;
    subcategories[categoryKey] ??= {};
    subcategories[categoryKey][subKey] = buildSubcategoryContent(
      locale === "es" ? input.titleEs.trim() : input.titleEn.trim(),
      locale === "es" ? (input.descriptionEs ?? "") : (input.descriptionEn ?? ""),
      locale,
    );
    writeFullCatalog(locale, { ...full, subcategories });
  }

  updateProductImages(categoryKey, subKey);
}

/**
 * VERSION-PLAN.md parser — reads the markdown source of truth and returns
 * structured version/feature data for DB sync.
 */

export interface VersionFeature {
  id: string;
  title: string;
  status: 'planned' | 'in-progress' | 'blocked' | 'done';
  agent?: string;
  design?: string;
}

export interface Version {
  id: string;
  semver: string;
  codename: string;
  status: 'planned' | 'in-progress' | 'released' | 'archived';
  target_date?: string;
  features: VersionFeature[];
}

const STATUS_MAP: Record<string, Version['status']> = {
  'planned': 'planned',
  'in-progress': 'in-progress',
  'released': 'released',
  'archived': 'archived',
};

const FEATURE_STATUS_MAP: Record<string, VersionFeature['status']> = {
  'planned': 'planned',
  'in-progress': 'in-progress',
  'blocked': 'blocked',
  'done': 'done',
};

// A checkbox is binary (`- [ ]` / `- [x]`), so it can only ever tell us
// "not done" vs "done" — it has no way to express 'in-progress' or 'blocked'.
// Those two states must come from an explicit `status:` key in the metadata
// suffix; a checked box always wins over metadata (it's the more recent,
// more visible signal), and an unchecked box with no metadata defaults to
// 'planned'.
function featureStatus(done: boolean, metaStatus: string | undefined): VersionFeature['status'] {
  if (done) return 'done';
  if (metaStatus) {
    const mapped = FEATURE_STATUS_MAP[metaStatus.toLowerCase()];
    if (mapped && mapped !== 'done') return mapped;
  }
  return 'planned';
}

// Slugify a feature title into an id fragment: lowercase, non-alphanumeric
// runs collapsed to single hyphens, trimmed. Deterministic and stable across
// reorderings of the file (unlike a features.length index).
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseVersionPlan(md: string): Version[] {
  const versions: Version[] = [];
  const lines = md.split('\n');
  let current: Version | null = null;

  for (const line of lines) {
    const versionMatch = line.match(/^## (v[\d.]+)\s*[—–-]\s*(.+)$/);
    if (versionMatch) {
      current = {
        id: versionMatch[1].replace(/\./g, '-'),
        semver: versionMatch[1],
        codename: versionMatch[2].trim(),
        status: 'planned',
        features: [],
      };
      versions.push(current);
      continue;
    }

    if (!current) continue;

    const statusMatch = line.match(/^Status:\s*(.+)$/);
    if (statusMatch) {
      const s = statusMatch[1].trim().toLowerCase();
      current.status = STATUS_MAP[s] ?? 'planned';
      continue;
    }

    const targetMatch = line.match(/^Target:\s*(.+)$/);
    if (targetMatch) {
      current.target_date = targetMatch[1].trim();
      continue;
    }

    const featureMatch = line.match(/^- \[([ xX])\]\s*(.+)$/);
    if (featureMatch) {
      const done = featureMatch[1].toLowerCase() === 'x';
      let title = featureMatch[2].trim();
      let id = '';
      let agent: string | undefined;
      let design: string | undefined;
      let metaStatus: string | undefined;

      const metaMatch = title.match(/\{([^}]+)\}$/);
      if (metaMatch) {
        title = title.slice(0, metaMatch.index).trim();
        const meta = metaMatch[1];
        const idM = meta.match(/id:\s*([\w-]+)/);
        if (idM) id = idM[1];
        const agentM = meta.match(/agent:\s*([\w-]+)/);
        if (agentM) agent = agentM[1];
        const designM = meta.match(/design:\s*([\w-]+)/);
        if (designM) design = designM[1];
        const statusM = meta.match(/status:\s*([\w-]+)/);
        if (statusM) metaStatus = statusM[1];
      }

      // Fall back to a slug of the version + title rather than a features[]
      // index — an index renumbers every later feature when one is inserted
      // in the middle, and since sync upserts by id, that renumber silently
      // rewrites the wrong DB rows instead of adding a new one.
      if (!id) id = `${current.id}-${slugify(title)}`;

      current.features.push({
        id,
        title,
        status: featureStatus(done, metaStatus),
        agent,
        design,
      });
    }
  }

  return versions;
}

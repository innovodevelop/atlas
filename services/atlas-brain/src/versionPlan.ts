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
      }

      if (!id) id = `feat-auto-${current.features.length}`;

      current.features.push({
        id,
        title,
        status: done ? 'done' : (current.status === 'in-progress' ? 'planned' : 'planned'),
        agent,
        design,
      });
    }
  }

  return versions;
}

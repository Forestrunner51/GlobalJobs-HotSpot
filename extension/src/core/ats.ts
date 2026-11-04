// Which applicant tracking system (ATS) a page belongs to, from its URL. Each ATS gets its own
// adapter (Phase 2+); until one exists for a system, the popup says so instead of guessing.

export type AtsId = 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'icims';

export interface AtsInfo {
  id: AtsId;
  label: string;
}

const PATTERNS: Array<[AtsId, string, RegExp]> = [
  // Hosted boards, plus the embed many company careers pages iframe in (?gh_jid= on their URL).
  ['greenhouse', 'Greenhouse', /^https:\/\/((job-)?boards(-api)?\.greenhouse\.io|[\w-]+\.greenhouse\.io\/embed)\/|[?&]gh_jid=\d+/],
  ['lever', 'Lever', /^https:\/\/jobs\.(eu\.)?lever\.co\//],
  ['workday', 'Workday', /^https:\/\/[\w.-]+\.(myworkdayjobs|myworkdaysite)\.com\/|^https:\/\/wd\d+\.myworkday\.com\//],
  ['ashby', 'Ashby', /^https:\/\/jobs\.ashbyhq\.com\//],
  ['icims', 'iCIMS', /^https:\/\/[\w.-]+\.icims\.com\//],
];

export function detectAts(url: string | undefined): AtsInfo | null {
  if (!url) return null;
  for (const [id, label, re] of PATTERNS) if (re.test(url)) return { id, label };
  return null;
}

/** Systems with a working adapter. Filled in as each phase lands. */
export const SUPPORTED: ReadonlySet<AtsId> = new Set<AtsId>(['greenhouse', 'workday', 'lever']);

/** Which phase brings each system, for the popup's "not yet" message. */
export const PLANNED_PHASE: Record<AtsId, number | null> = {
  greenhouse: 2, lever: 3, workday: 5, ashby: null, icims: null,
};


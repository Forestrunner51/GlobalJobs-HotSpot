// Pure logic for the job postings view: filtering, metro markers and the text handed
// to apply/jobprep.py. Rendering lives in main.js.

export const WHERE = ['all', 'us', 'remote'];

/** Keyword in the title, or mentioned at least twice: the posting is about it, not listing it in passing. */
export const isFocused = (job) => job.inTitle || job.mentions >= 2;

export function filterJobs(jobs, { q = '', where = 'all', focus = false, metro = null } = {}) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return jobs.filter((j) => {
    if (where === 'us' && !(j.us || j.regionIds.length)) return false;
    if (where === 'remote' && !j.remote) return false;
    if (focus && !isFocused(j)) return false;
    if (metro && !j.regionIds.includes(metro)) return false;
    if (!words.length) return true;
    const hay = `${j.title} ${j.company} ${j.location} ${j.keywords.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** One marker per metro with the number of postings there, most first (the views' marker shape). */
export function jobMarkers(jobs, metroById) {
  const byMetro = new Map();
  for (const j of jobs) {
    for (const id of j.regionIds) {
      const info = metroById.get(id);
      if (!info) continue;
      let m = byMetro.get(id);
      if (!m) {
        m = { regionId: id, regionLabel: info.regionLabel, lat: Number(info.lat), lng: Number(info.lng), value: 0, jobs: [] };
        byMetro.set(id, m);
      }
      m.value += 1;
      m.jobs.push(j);
    }
  }
  return [...byMetro.values()].sort((a, b) => b.value - a.value || a.regionLabel.localeCompare(b.regionLabel));
}

export function strengthLabel(job) {
  const kw = job.keywords.join(', ');
  if (job.inTitle) return `${kw} in title`;
  return job.mentions >= 2 ? `mentions ${kw} ${job.mentions}×` : `mentions ${kw} once`;
}

export function postedLabel(iso, today = new Date()) {
  if (!iso) return '';
  const days = Math.floor((today - new Date(`${iso}T12:00:00Z`)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);

/** The posting as plain text in the shape apply/jobprep.py reads from stdin. */
export function postingForPrep(job, text) {
  return [
    `Source: ${job.url}`,
    job.applyUrl && job.applyUrl !== job.url ? `Apply: ${job.applyUrl}` : null,
    '',
    `${job.title}`,
    `${job.company}${job.location ? ` · ${job.location}` : ''}${job.remote ? ' · Remote' : ''}`,
    job.salary ? `Compensation: ${job.salary}` : null,
    '',
    text || job.snippet || '',
  ].filter((line) => line !== null).join('\n');
}

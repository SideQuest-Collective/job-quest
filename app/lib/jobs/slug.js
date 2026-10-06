// app/lib/jobs/slug.js
const MAX = 80;

function slugify(text) {
  const s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/g, '');
  return s || 'role';
}

function uniqueSlug(base, exists) {
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX - suffix.length).replace(/-+$/g, '') + suffix;
    if (!exists(candidate)) return candidate;
  }
}

function roleSlug(company, role, exists) {
  return uniqueSlug(slugify(`${company || ''} ${role || ''}`), exists);
}

module.exports = { slugify, uniqueSlug, roleSlug };

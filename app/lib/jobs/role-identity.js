// app/lib/jobs/role-identity.js
// One role identity for the server, the daily runner and the browser (served at /role-identity.js).
// Two roles are the same when they share a specific posting ID (ATS job ID, LinkedIn job ID,
// or a specific employer posting URL at the same company), or when their companies match and
// their titles match after normalization (seniority must agree; team/specialty words must agree).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JobQuestRoleIdentity = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const TRACKING_PARAM = /^(utm_|gh_src$|source$|src$|ref$|refid$|trk$|trkinfo$|tracking|lever-|lever_|ashby_|mode$|t$|ccuid$|ebp$|eid$|position$|pagenum$|origin$)/i;
  const APPLY_SUFFIX = /\/(apply|application|apply-now|applynow)$/i;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  function parseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      return url;
    } catch { return null; }
  }
  const hostOf = url => url.hostname.toLowerCase().replace(/^www\./, '');
  const segmentsOf = url => url.pathname.replace(APPLY_SUFFIX, '').split('/').filter(Boolean);

  // Returns { key, url } where key identifies the posting (null when the URL is not specific
  // to one posting, e.g. a careers landing page) and url is the canonical URL form.
  function postingIdentity(value) {
    const url = parseUrl(value);
    if (!url) return { key: null, url: null };
    const host = hostOf(url);
    const segs = segmentsOf(url);
    const q = name => url.searchParams.get(name);
    // Greenhouse: board pages, embedded application, and company sites carrying ?gh_jid=.
    const ghJid = q('gh_jid');
    if (/(^|\.)greenhouse\.io$/.test(host)) {
      if (segs[0] === 'embed' && q('token') && /^\d+$/.test(q('token'))) {
        const board = (q('for') || '').toLowerCase();
        const id = q('token');
        return { key: `greenhouse:${id}`, url: board ? `https://job-boards.greenhouse.io/${board}/jobs/${id}` : `https://job-boards.greenhouse.io/embed/job_app?token=${id}` };
      }
      const jobsAt = segs.indexOf('jobs');
      if (jobsAt > 0 && /^\d+$/.test(segs[jobsAt + 1] || '')) {
        const id = segs[jobsAt + 1];
        return { key: `greenhouse:${id}`, url: `https://job-boards.greenhouse.io/${segs[jobsAt - 1].toLowerCase()}/jobs/${id}` };
      }
    }
    if (ghJid && /^\d+$/.test(ghJid)) return { key: `greenhouse:${ghJid}`, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}?gh_jid=${ghJid}` };
    // Ashby: jobs.ashbyhq.com/<org>/<uuid>[/application]
    if (host === 'jobs.ashbyhq.com' && segs.length >= 2 && UUID.test(segs[1])) {
      const id = segs[1].toLowerCase();
      return { key: `ashby:${id}`, url: `https://jobs.ashbyhq.com/${segs[0].toLowerCase()}/${id}` };
    }
    // Lever: jobs.lever.co/<org>/<uuid>[/apply]
    if (/^jobs\.(eu\.)?lever\.co$/.test(host) && segs.length >= 2 && UUID.test(segs[1])) {
      const id = segs[1].toLowerCase();
      return { key: `lever:${id}`, url: `https://${host}/${segs[0].toLowerCase()}/${id}` };
    }
    // LinkedIn: /jobs/view/<slug>-<id>, /jobs/view/<id>/, or ?currentJobId=<id>
    if (/(^|\.)linkedin\.com$/.test(host)) {
      let id = null;
      const viewAt = segs.indexOf('view');
      if (segs[0] === 'jobs' && viewAt === 1 && segs[2]) id = (segs[2].match(/(\d{6,})$/) || [])[1] || null;
      if (!id && /^\d{6,}$/.test(q('currentJobId') || '')) id = q('currentJobId');
      if (id) return { key: `linkedin:${id}`, url: `https://www.linkedin.com/jobs/view/${id}/` };
    }
    // Workday: .../job/<location>/<Title-Slug>_<REQ-ID>
    if (/myworkday(jobs|site)\.com$/.test(host)) {
      const last = segs[segs.length - 1] || '';
      const req = (last.match(/_([A-Za-z0-9-]+)$/) || [])[1];
      if (req) {
        const tenant = host.split('.')[0] === 'wd1' || /^wd\d+$/.test(host.split('.')[0]) ? (segs[1] || host) : host.split('.')[0];
        return { key: `workday:${tenant.toLowerCase()}:${req.toLowerCase()}`, url: `${url.origin}${url.pathname.replace(APPLY_SUFFIX, '').replace(/\/+$/, '')}` };
      }
    }
    // Built In: builtin.com/job/<slug>/<id>
    if (/(^|\.)builtin(nyc)?\.com$/.test(host) && segs[0] === 'job' && /^\d+$/.test(segs[segs.length - 1] || '')) {
      return { key: `builtin:${segs[segs.length - 1]}`, url: `https://builtin.com/job/${segs.slice(1).join('/')}` };
    }
    // Any other employer site: keep host + path + non-tracking query.
    const params = [...url.searchParams.entries()].filter(([name]) => !TRACKING_PARAM.test(name)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    const pathname = `/${segs.join('/')}`;
    const canonical = `https://${host}${pathname === '/' ? '' : pathname}${query}`;
    return { key: isSpecificPosting(segs, params) ? `url:${canonical.slice(8).toLowerCase()}` : null, url: canonical };
  }

  // A generic URL identifies one posting only when it carries an ID or a long title slug.
  function isSpecificPosting(segs, params) {
    if (segs.some(s => /search|results$/i.test(s) && !/\d{5,}/.test(s))) {
      if (!params.some(([k, v]) => /job|id|req/i.test(k) && /\d{4,}|[0-9a-f-]{16,}/i.test(v))) return false;
    }
    const last = segs[segs.length - 1] || '';
    if (/\d{5,}/.test(last) || UUID.test(last)) return true;
    if (segs.length >= 2 && (last.match(/-/g) || []).length >= 3 && !/^(careers?|jobs?|openings?|positions?)$/i.test(last)) return true;
    return params.some(([k, v]) => /^(job_?id|jobid|jid|id|req(id)?|token|posting_?id|gh_jid)$/i.test(k) && /^[A-Za-z0-9-]{4,}$/.test(v));
  }

  const canonicalPostingUrl = value => postingIdentity(value).url;
  const postingKey = value => postingIdentity(value).key;

  const fold = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---- Company ----
  const COMPANY_SUFFIX = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'sa', 'ag',
    'technologies', 'technology', 'tech', 'labs', 'lab', 'ai', 'hq', 'io', 'app', 'health', 'healthcare', 'group', 'holdings', 'software',
    'systems', 'solutions', 'platforms', 'global', 'usa', 'us', 'investments', 'capital', 'careers', 'jobs', 'financial', 'bank', 'studios', 'studio']);
  function normalizeCompanyName(value) {
    let text = fold(value).replace(/&/g, ' and ').replace(/\b([a-z0-9-]+)\.(com|ai|io|co|app|dev|xyz|so|net|org)\b/g, '$1');
    text = text.replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
    const tokens = text.split(' ').filter(Boolean);
    while (tokens.length > 1 && COMPANY_SUFFIX.has(tokens[tokens.length - 1])) tokens.pop();
    return tokens.join(' ');
  }
  // "Cursor (Anysphere)" is known as both cursor and anysphere.
  function companyAliases(value) {
    const raw = String(value || '');
    const aliases = new Set();
    const outside = raw.replace(/\([^)]*\)/g, ' ');
    const main = normalizeCompanyName(outside);
    if (main) aliases.add(main);
    for (const match of raw.matchAll(/\(([^)]*)\)/g)) {
      for (const part of match[1].split(/[,/]| formerly | aka /i)) {
        const alias = normalizeCompanyName(part.replace(/^(formerly|aka|dba)\s+/i, ''));
        if (alias && alias.length > 1) aliases.add(alias);
      }
    }
    if (!aliases.size) { const whole = normalizeCompanyName(raw); if (whole) aliases.add(whole); }
    return [...aliases];
  }
  const normalizeCompany = value => companyAliases(value)[0] || '';
  function companiesMatch(a, b) {
    const left = companyAliases(a);
    const right = new Set(companyAliases(b));
    return left.some(alias => right.has(alias));
  }

  // ---- Title ----
  const LOCATION_PHRASES = /\b(new york city|new york|san francisco bay area|san francisco|bay area|los angeles|united states|north america|united kingdom|in office|on site)\b/g;
  const LOCATION_TOKENS = new Set(['nyc', 'ny', 'sf', 'sfo', 'la', 'remote', 'hybrid', 'onsite', 'us', 'usa', 'uk', 'brooklyn', 'manhattan', 'london',
    'seattle', 'boston', 'austin', 'chicago', 'toronto', 'denver', 'miami', 'atlanta', 'amer', 'americas', 'emea', 'apac', 'canada', 'nj', 'ca', 'wa', 'tx', 'ma']);
  const STOPWORDS = new Set(['and', 'of', 'the', 'for', 'a', 'an', 'to', 'in', 'at', 'with', 'on', 'team', 'role', 'position', 'opening', 'based', 'm', 'f', 'd', 'x']);
  const SENIORITY = new Set(['senior', 'staff', 'principal', 'lead', 'junior', 'founding', 'distinguished', 'head', 'intern', 'associate', 'mid', 'entry', 'chief', 'vp', 'director', 'fellow', 'new', 'grad', 'graduate']);
  const GENERIC = new Set(['engineer', 'software']);
  const ROMAN = { i: '1', ii: '2', iii: '3', iv: '4', v: '5', vi: '6' };

  function titleSignature(value) {
    const raw = fold(value);
    const combined = /\b(senior|sr|staff|principal|lead)\.?\s*(\/|\bor\b|&|\band\b|-)\s*(senior|sr|staff|principal|lead)\b/.test(raw);
    let text = raw
      .replace(/&/g, ' and ')
      .replace(/\bsr\b\.?|\bsnr\b\.?/g, ' senior ')
      .replace(/\bjr\b\.?/g, ' junior ')
      .replace(/\bfull[\s\-–/]*stack\b/g, ' fullstack ')
      .replace(/\bfront[\s\-–]*end\b/g, ' frontend ')
      .replace(/\bback[\s\-–]*end\b/g, ' backend ')
      .replace(/\bmachine[\s-]+learning\b/g, ' ml ')
      .replace(/\bartificial[\s-]+intelligence\b/g, ' ai ')
      .replace(/\bgen[\s-]?ai\b/g, ' genai ')
      .replace(/\bsite[\s-]+reliability\b/g, ' sre ')
      .replace(/\bdev[\s-]?ops\b/g, ' devops ')
      .replace(/\bengineering[\s-]+manager\b/g, ' engineeringmanager ')
      .replace(/\bsoftware[\s-]+development[\s-]+engineer\b/g, ' software engineer ')
      .replace(/\b(sde|swe)\b/g, ' software engineer ')
      .replace(/\b(engineering|engr|eng|developer|development|dev)\b/g, ' engineer ')
      .replace(/\b(level|lvl)[\s-]*(\d)\b/g, ' lvl$2 ')
      .replace(/\b[le](\d)\b/g, ' lvl$1 ')
      .replace(/\bic(\d)\b/g, ' lvl$1 ')
      .replace(LOCATION_PHRASES, ' ');
    const tokens = text.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean)
      .map(token => ROMAN[token] ? `lvl${ROMAN[token]}` : /^\d$/.test(token) ? `lvl${token}` : token)
      .filter(token => !LOCATION_TOKENS.has(token) && !STOPWORDS.has(token) && !/^(r|jr|req|job)?\d{4,}$/.test(token))
      .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token);
    const seniority = new Set(), levels = new Set(), specific = new Set(), core = new Set();
    for (const token of tokens) {
      if (SENIORITY.has(token)) seniority.add(token);
      else if (/^lvl\d$/.test(token)) levels.add(token);
      else { core.add(token); if (!GENERIC.has(token)) specific.add(token); }
    }
    return { seniority, levels, specific, core, combined };
  }
  const normalizeTitle = value => {
    const sig = titleSignature(value);
    return [...sig.seniority].sort().concat([...sig.levels].sort(), [...sig.core].sort()).join(' ');
  };

  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  const subset = (a, b) => [...a].every(x => b.has(x));
  function seniorityMatches(a, b) {
    if (sameSet(a.seniority, b.seniority)) return true;
    // "Senior / Staff Product Engineer" is one listing open at either level.
    if (a.combined && b.seniority.size && subset(b.seniority, a.seniority)) return true;
    if (b.combined && a.seniority.size && subset(a.seniority, b.seniority)) return true;
    return false;
  }
  function titlesMatch(left, right) {
    const a = typeof left === 'string' ? titleSignature(left) : left;
    const b = typeof right === 'string' ? titleSignature(right) : right;
    if (!seniorityMatches(a, b)) return false;
    if (a.levels.size && b.levels.size && !sameSet(a.levels, b.levels)) return false;
    if (!a.specific.size && !b.specific.size) return sameSet(a.core, b.core);
    if (sameSet(a.specific, b.specific)) return true;
    // Tolerate one extra descriptive word on an otherwise identical, detailed title.
    const [small, large] = a.specific.size <= b.specific.size ? [a.specific, b.specific] : [b.specific, a.specific];
    return small.size >= 3 && large.size === small.size + 1 && subset(small, large);
  }

  const roleTitle = role => role?.role ?? role?.title ?? '';
  const roleKeyOf = role => `${role?.company}|${roleTitle(role)}`;
  function splitKey(key) {
    const text = String(key || '');
    const at = text.indexOf('|');
    return at === -1 ? { company: text, title: '' } : { company: text.slice(0, at), title: text.slice(at + 1) };
  }

  // Same role? a and b are { company, role|title, url }.
  function sameRole(a, b) {
    const left = postingIdentity(a?.url), right = postingIdentity(b?.url);
    if (left.key && left.key === right.key) {
      if (!left.key.startsWith('url:')) return true;
      if (companiesMatch(a.company, b.company)) return true;
    }
    return companiesMatch(a?.company, b?.company) && titlesMatch(roleTitle(a), roleTitle(b));
  }

  // An index of known roles (handled ledger, current state) for fast identity lookups.
  function createRoleIndex(entries = []) {
    const byKey = new Map(), byPosting = new Map(), byCompany = new Map();
    function add(entry) {
      if (!entry) return;
      const company = entry.company ?? splitKey(entry.key).company;
      const title = entry.title ?? entry.role ?? splitKey(entry.key).title;
      const item = { ...entry, company, title, sig: titleSignature(title), aliases: companyAliases(company) };
      if (entry.key) byKey.set(entry.key, item);
      for (const key of entry.keys || []) byKey.set(key, item);
      const posting = postingIdentity(entry.url).key;
      if (posting) byPosting.set(posting, item);
      for (const alias of item.aliases) {
        if (!byCompany.has(alias)) byCompany.set(alias, []);
        byCompany.get(alias).push(item);
      }
    }
    function match(role) {
      if (!role) return null;
      for (const key of [...(role.keys || []), roleKeyOf(role)]) if (byKey.has(key)) return byKey.get(key);
      const posting = postingIdentity(role.url).key;
      const hit = posting && byPosting.get(posting);
      if (hit && (!posting.startsWith('url:') || companiesMatch(hit.company, role.company))) return hit;
      const sig = titleSignature(roleTitle(role));
      const titles = [roleTitle(role), ...(role.keys || []).map(key => splitKey(key).title)];
      for (const alias of companyAliases(role.company)) {
        for (const item of byCompany.get(alias) || []) {
          if (titlesMatch(sig, item.sig)) return item;
          if (titles.length > 1 && titles.some(title => titlesMatch(title, item.sig))) return item;
        }
      }
      return null;
    }
    entries.forEach(add);
    return { add, match, size: () => byKey.size };
  }

  // Collapse the same role across reports. Newest report wins; every key it was known by is kept.
  function dedupeRoles(reports) {
    const ordered = [...(reports || [])].map((report, index) => ({ report, index }))
      .sort((a, b) => String(b.report?.date || '').localeCompare(String(a.report?.date || '')) || a.index - b.index);
    const groups = [];
    const index = createRoleIndex();
    for (const { report } of ordered) {
      for (const role of report?.roles || []) {
        if (!role || typeof role !== 'object') continue;
        const key = roleKeyOf(role);
        const hit = index.match(role);
        if (hit) {
          const group = groups[hit.group];
          if (!group.keys.includes(key)) group.keys.push(key);
          if (!group.urls.includes(role.url) && role.url) group.urls.push(role.url);
          group.seenDates.push(report.date);
          index.add({ key, company: role.company, title: roleTitle(role), url: role.url, group: hit.group });
          continue;
        }
        const groupId = groups.length;
        const safeUrl = parseUrl(role.url)?.protocol === 'https:' ? role.url : null;
        groups.push({ role: { ...role, url: safeUrl, intelDate: report.date }, keys: [key], urls: role.url ? [role.url] : [], seenDates: [report.date] });
        index.add({ key, company: role.company, title: roleTitle(role), url: role.url, group: groupId });
      }
    }
    return groups.map(group => ({ ...group.role, keys: group.keys, postingKey: postingIdentity(group.urls[0]).key || null }));
  }

  return {
    postingIdentity, postingKey, canonicalPostingUrl, normalizeCompany, normalizeCompanyName, companyAliases, companiesMatch,
    titleSignature, normalizeTitle, titlesMatch, sameRole, splitKey, roleKeyOf, createRoleIndex, dedupeRoles,
  };
});

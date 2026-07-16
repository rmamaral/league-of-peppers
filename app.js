/* League of Bot — app logic
   Pulls the live patch + champion + item metadata from Data Dragon (no key),
   renders curated rolls from data.js, and validates the curation on load. */

const DDRAGON = 'https://ddragon.leagueoflegends.com';
let VERSION = '15.1.1';          // fallback if the version fetch fails
let CHAMPS = {};                 // ddragon id -> { name, ... }
let ITEMS = {};                  // normalized name -> { id, image, name }
let currentMode = 'solo';
let RUNE_ICONS = {};             // normalized rune/style name -> icon URL
let RUNE_DESC = {};              // normalized rune name -> shortDesc (ddragon)
let RUNE_STYLES = new Set();     // style (tree) display names
let currentRoll = null;          // { mode, entry, spicy } — the roll on screen
let rollHistory = [];            // last rolls, newest first (max 5)
const locks = new Set();         // champ ids locked for reroll (duo/comp)

const $ = (sel) => document.querySelector(sel);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const normItem = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''); // apostrophe/space proof

/* ---- Boot: fetch patch version + champion + item data --------------------- */
async function boot() {
  try {
    const versions = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
    VERSION = versions[0];
    const [champJson, itemJson, runesJson] = await Promise.all([
      fetch(`${DDRAGON}/cdn/${VERSION}/data/en_US/champion.json`).then((r) => r.json()),
      fetch(`${DDRAGON}/cdn/${VERSION}/data/en_US/item.json`).then((r) => r.json()),
      fetch(`${DDRAGON}/cdn/${VERSION}/data/en_US/runesReforged.json`).then((r) => r.json()),
    ]);
    CHAMPS = champJson.data; // keyed by ddragon id
    Object.entries(itemJson.data).forEach(([id, it]) => {
      ITEMS[normItem(it.name)] = { id, image: it.image.full, name: it.name, desc: it.description || '' };
    });
    runesJson.forEach((style) => {
      RUNE_STYLES.add(style.name);
      RUNE_ICONS[normItem(style.name)] = `${DDRAGON}/cdn/img/${style.icon}`;
      style.slots.forEach((slot) => slot.runes.forEach((r) => {
        RUNE_ICONS[normItem(r.name)] = `${DDRAGON}/cdn/img/${r.icon}`;
        RUNE_DESC[normItem(r.name)] = r.shortDesc || r.longDesc || '';
      }));
    });
  } catch (err) {
    console.warn('Data Dragon fetch failed, using fallbacks.', err);
  }
  $('#patch').textContent = VERSION;
  validateCuration();
  applyHash(); // restore a shared roll from the URL, if any
}

/* ---- Data-update guardrail ------------------------------------------------ */
/* Checks every curated champ id + item name against the LIVE ddragon data and
   reports anything stale. This is how we catch balance/patch drift. */
function validateCuration() {
  if (!Object.keys(CHAMPS).length) return; // offline — nothing to validate against
  const missingChamps = new Set();
  const seeChamp = (id) => { if (!CHAMPS[id]) missingChamps.add(id); };
  SPICY.forEach((s) => seeChamp(s.id));
  CLASSIC.forEach((c) => seeChamp(c.id));
  DUOS.forEach((d) => { seeChamp(d.adc); seeChamp(d.sup); });
  SPICY_DUOS.forEach((d) => { seeChamp(d.adc); seeChamp(d.sup); });
  COMPS.forEach((c) => c.champs.forEach((x) => seeChamp(x.id)));

  const missingItems = new Set();
  const missingUses = new Set();
  const checkPath = (path) => (path || []).forEach((n) => {
    if (!resolveItem(n)) missingItems.add(n);
    if (!ITEM_USES[n]) missingUses.add(n);
  });
  SPICY.forEach((s) => checkPath(s.build?.path));
  SPICY_DUOS.forEach((d) => { checkPath(d.builds?.adc?.path); checkPath(d.builds?.sup?.path); });
  Object.values(BUILDS).forEach((b) => checkPath(b.path));
  Object.values(BUILD_TEMPLATES).forEach((path) => checkPath(path));

  const missingRunes = new Set();
  if (Object.keys(RUNE_ICONS).length) {
    const seeRune = (r) => {
      if (!r) return;
      const [keystone, secondary] = r.split(' · ');
      if (!RUNE_ICONS[normItem(keystone)]) missingRunes.add(keystone);
      if (secondary && !RUNE_STYLES.has(secondary)) missingRunes.add(secondary);
    };
    Object.values(RUNES).forEach(seeRune);
    SPICY.forEach((s) => seeRune(s.build?.rune));
    SPICY_DUOS.forEach((d) => { seeRune(d.builds?.adc?.rune); seeRune(d.builds?.sup?.rune); });
  }

  const stamp = `curation reviewed @ ${CURATION_META.reviewedPatch} · live @ ${VERSION}`;
  if (missingChamps.size || missingItems.size || missingUses.size || missingRunes.size) {
    console.group('%cLeague of Bot — curation needs a look', 'color:#c8aa6e;font-weight:bold');
    if (missingChamps.size) console.warn('Unknown champion ids (fix in data.js):', [...missingChamps]);
    if (missingItems.size) console.warn('Item names not found this patch (renamed/removed?):', [...missingItems]);
    if (missingUses.size) console.warn('Built items with no ITEM_USES caption:', [...missingUses]);
    if (missingRunes.size) console.warn('Rune/tree names not found this patch:', [...missingRunes]);
    console.info(stamp);
    console.groupEnd();
  } else {
    console.info(`%cLeague of Bot ✓ all curation resolves — ${stamp}`, 'color:#0ac8b9');
  }
}

/* ---- Rich hover tooltips (item + rune descriptions from ddragon) ----------- */
// Data Dragon descriptions are HTML with custom tags (<stats>, <passive>,
// <scaleAP>, <lol-uikit-tooltipped-keyword>…). Convert them to clean, styled
// markup: keep line breaks + emphasis, drop the tags we don't render.
function formatDDragon(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(mainText|stats|passive|active|attention|scaleAP|scaleAD|scaleHealth|scaleMana|scaleLevel|status|physicalDamage|magicDamage|trueDamage|healing|shield|speed|rules|flavorText|keywordMajor)>/gi, '</span>')
    .replace(/<(mainText|rules|flavorText)>/gi, '<span class="tt-$1">')
    .replace(/<(passive|active)>/gi, '<span class="tt-head">')
    .replace(/<(attention|scaleAP|scaleAD|scaleHealth|scaleMana|scaleLevel|speed)>/gi, '<span class="tt-num">')
    .replace(/<stats>/gi, '<span class="tt-stats">')
    .replace(/<(status|physicalDamage|magicDamage|trueDamage|healing|shield|keywordMajor)>/gi, '<span class="tt-kw">')
    .replace(/<\/?lol-uikit-tooltipped-keyword[^>]*>/gi, '')
    .replace(/<font[^>]*>|<\/font>/gi, '')
    .replace(/<(b|i|li|ul)>/gi, '<$1>')                 // keep basic emphasis/lists
    .replace(/<[^>]+>/g, (m) => (/^<\/?(span|b|i|ul|li)\b/i.test(m) ? m : '')) // strip anything left
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\n/g, '<br>');
}

function itemTip(name) {
  const it = resolveItem(name);
  if (!it) return '';
  const body = formatDDragon(it.desc) || (ITEM_USES[name] || '');
  return `<div class="tt-title">${it.name}</div>${body ? `<div class="tt-body">${body}</div>` : ''}`;
}
function runeTip(rune) {
  const [keystone, secondary] = rune.split(' · ');
  const body = formatDDragon(RUNE_DESC[normItem(keystone)] || '');
  const sub = secondary ? `<div class="tt-sub">Secondary tree: ${secondary}</div>` : '';
  return `<div class="tt-title">${keystone}</div>${sub}${body ? `<div class="tt-body">${body}</div>` : ''}`;
}

// One shared tooltip element, positioned near the cursor. Content is encoded in
// data-tip on the trigger (built by itemTip / runeTip at render time).
let tipEl = null;
function tipNode() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(target, x, y) {
  const html = target.dataset.tip;
  if (!html) return;
  const t = tipNode();
  t.innerHTML = decodeURIComponent(html);
  t.classList.add('is-on');
  positionTip(x, y);
}
function positionTip(x, y) {
  if (!tipEl) return;
  const pad = 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;   // flip left near right edge
  if (top + h > window.innerHeight - 8) top = y - h - pad;    // flip up near bottom
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${Math.max(8, top)}px`;
}
function hideTip() { if (tipEl) tipEl.classList.remove('is-on'); }

// Delegated hover: any element carrying data-tip gets the rich tooltip.
document.addEventListener('pointerover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t, e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => {
  if (tipEl && tipEl.classList.contains('is-on')) positionTip(e.clientX, e.clientY);
});
document.addEventListener('pointerout', (e) => {
  if (e.target.closest('[data-tip]')) hideTip();
});
// Tap-to-dismiss on touch (a tap fires pointerover but no pointerout).
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('[data-tip]')) hideTip(); });

const tipAttr = (html) => (html ? ` data-tip="${encodeURIComponent(html)}"` : '');

/* ---- Helpers -------------------------------------------------------------- */
function champName(id) {
  return (CHAMPS[id] && CHAMPS[id].name) || id.replace(/([a-z])([A-Z])/g, '$1 $2');
}
function portrait(id, sm) {
  const name = champName(id);
  const cls = sm ? 'portrait sm' : 'portrait';
  return `<img class="${cls}" src="${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png" alt="${name}"
    onerror="this.style.visibility='hidden'" loading="lazy" />`;
}
function resolveItem(name) {
  return ITEMS[normItem(name)] || null;
}
function itemCells(path) {
  return (path || []).map((name) => {
    const it = resolveItem(name);
    const use = ITEM_USES[name] || '';
    const icon = it
      ? `<img class="item" src="${DDRAGON}/cdn/${VERSION}/img/item/${it.image}"
          alt="${it.name}"${tipAttr(itemTip(name))} loading="lazy" />`
      : `<span class="item item--missing" title="not found in patch ${VERSION}">${name}</span>`;
    const caption = use || (it ? it.name : name);
    return `<div class="item-cell">${icon}<span class="item-use">${caption}</span></div>`;
  }).join('');
}
// Rune string for a champ: inline build override wins, else the shared library.
function runeFor(id, build) {
  return (build && build.rune) || RUNES[id] || '';
}
function runeChip(rune) {
  if (!rune) return '';
  const [keystone, secondary] = rune.split(' · ');
  const ic = RUNE_ICONS[normItem(keystone)];
  const img = ic ? `<img class="rune-ic" src="${ic}" alt="" loading="lazy" />` : '';
  return `<span class="rune"${tipAttr(runeTip(rune))}>${img}${keystone}${
    secondary ? `<span class="rune-sec">+ ${secondary}</span>` : ''}</span>`;
}
function buildBlock(build, label, rune) {
  if (!build || !build.path) return '';
  const head = label
    ? `<span class="build-champ">${label}</span>`
    : 'Build path';
  return `<div class="build">
      <div class="build-head">${head} ${build.skill ? `<span class="skill">Max ${build.skill}</span>` : ''} ${runeChip(rune)}</div>
      <div class="build-row">${itemCells(build.path)}</div>
    </div>`;
}
// Resolve a build for ANY champion: curated if we have one, else a template
// chosen from damage type + ddragon class (so the Team Analyzer covers all 173).
function buildFor(id) {
  if (BUILDS[id]) return BUILDS[id];
  const info = traitsFor(id);
  const cls = (CHAMPS[id] && CHAMPS[id].tags) || [];
  let key;
  if (info.dmg === 'tank') key = 'tank';
  else if (info.dmg === 'utility') key = 'enchanter';
  else if (info.dmg === 'AP') key = 'ap';
  else if (info.dmg === 'hybrid') key = cls.includes('Assassin') ? 'assassin' : 'ap';
  else if (cls.includes('Marksman')) key = 'marksman';
  else if (cls.includes('Assassin')) key = 'assassin';
  else key = 'bruiser';
  return { path: BUILD_TEMPLATES[key], generated: true };
}

// Compact per-champ builds (name + role/tag + skill order + item row)
function compBuilds(champs, label) {
  const rows = champs.map((x) => {
    const b = buildFor(x.id);
    const tag = [x.role, b.generated ? 'template' : ''].filter(Boolean).join(' · ');
    const skill = b.skill ? `<span class="cbuild-skill">Max ${b.skill}</span>` : '';
    return `<div class="cbuild-row">
        <div class="cbuild-champ"><span class="nm">${champName(x.id)}</span>${tag ? `<span class="rl">${tag}</span>` : ''}${skill}${runeChip(runeFor(x.id, b))}</div>
        <div class="cbuild-items">${itemCells(b.path)}</div>
      </div>`;
  }).join('');
  if (!rows) return '';
  return `<div class="comp-section">
      <span class="label">${label || 'Suggested builds'}</span>
      <div class="cbuild">${rows}</div>
    </div>`;
}

/* ---- Roll plumbing: locks, share links, history ---------------------------- */
// Pick from a pool, avoiding an immediate repeat of what's on screen.
function pickNew(pool) {
  if (pool.length > 1 && currentRoll && pool.includes(currentRoll.entry)) {
    return pick(pool.filter((e) => e !== currentRoll.entry));
  }
  return pick(pool);
}

// Entries that contain every locked champ. `ids(entry)` -> champ ids in it.
function lockFilter(base, ids) {
  if (!locks.size) return base;
  const p = base.filter((e) => [...locks].every((id) => ids(e).includes(id)));
  if (!p.length) { locks.clear(); return base; } // stale locks — reset
  return p;
}

function lockHint(base, ids) {
  if (!locks.size) return `<p class="lock-hint">Tap a champion to lock it — rerolls keep it.</p>`;
  const n = lockFilter(base, ids).length;
  const names = [...locks].map(champName).join(', ');
  return `<p class="lock-hint is-on">${names} locked — ${n === 1 ? 'this is the only curated roll' : `${n} curated rolls`} with that lock.</p>`;
}

// Make the rendered champs lock-toggleable (duo + comp cards).
function attachLocks() {
  $('#result').querySelectorAll('[data-lock]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.lock;
      locks.has(id) ? locks.delete(id) : locks.add(id);
      rerenderCurrent(); // refresh lock styling + hint without rerolling
    });
  });
}
const lockable = (id) =>
  `class="champ lockable${locks.has(id) ? ' is-locked' : ''}" data-lock="${id}"`;

function rerenderCurrent() {
  if (!currentRoll) return;
  if (currentRoll.mode === 'solo') renderSolo(currentRoll.entry);
  else if (currentRoll.mode === 'duo') renderDuo(currentRoll.entry);
  else renderComp(currentRoll.entry);
}

// Every render ends here: track the roll, sync the URL, log history.
function afterRoll(mode, entry, spicy = false) {
  currentRoll = { mode, entry, spicy };
  updateHash(currentRoll);
  pushHistory(currentRoll);
  $('#share').hidden = false;
}

function updateHash(roll) {
  let h = '';
  if (roll.mode === 'solo') h = `${roll.spicy ? 's' : 'sc'}=${roll.entry.id}:${roll.entry.role}`;
  else if (roll.mode === 'duo') h = `${roll.spicy ? 'sd' : 'd'}=${roll.entry.adc}+${roll.entry.sup}`;
  else h = `c=${encodeURIComponent(roll.entry.name)}`;
  history.replaceState(null, '', `#${h}`);
}

// #s=Twitch:Support · #sc=Ahri:Mid · #d=Draven+Thresh · #sd=Yasuo+Malphite · #c=Chain%20CC
function applyHash() {
  const m = location.hash.slice(1);
  if (!m.includes('=')) return;
  const [k, vRaw] = m.split('=');
  const v = decodeURIComponent(vRaw || '');
  if (k === 's' || k === 'sc') {
    const [id, role] = v.split(':');
    const e = (k === 's' ? SPICY : CLASSIC).find((s) => s.id === id && s.role === role);
    if (e) { setMode('solo', { fresh: false }); $('#solo-spice').value = k === 's' ? 'spicy' : 'classic'; renderSolo(e); }
  } else if (k === 'd' || k === 'sd') {
    const [adc, sup] = v.split('+');
    const e = (k === 'sd' ? SPICY_DUOS : DUOS).find((x) => x.adc === adc && x.sup === sup);
    if (e) { setMode('duo', { fresh: false }); $('#duo-spice').value = k === 'sd' ? 'spicy' : 'classic'; renderDuo(e); }
  } else if (k === 'c') {
    const e = COMPS.find((x) => x.name === v);
    if (e) { setMode('comp', { fresh: false }); renderComp(e); }
  }
}

function pushHistory(roll) {
  rollHistory = rollHistory.filter((h) => h.entry !== roll.entry);
  rollHistory.unshift(roll);
  if (rollHistory.length > 5) rollHistory.pop();
  renderHistory();
}

function renderHistory() {
  const inRollMode = !['analyzer', 'draft'].includes(currentMode);
  $('#history').hidden = !rollHistory.length || !inRollMode;
  $('#history-row').innerHTML = rollHistory.map((h, i) => {
    let faces, title;
    if (h.mode === 'solo') { faces = portrait(h.entry.id, true); title = `${champName(h.entry.id)} ${h.entry.role}`; }
    else if (h.mode === 'duo') { faces = portrait(h.entry.adc, true) + portrait(h.entry.sup, true); title = `${champName(h.entry.adc)} + ${champName(h.entry.sup)}`; }
    else { faces = `<span class="hist-name">${h.entry.name}</span>`; title = h.entry.name; }
    const cur = currentRoll && h.entry === currentRoll.entry ? ' is-current' : '';
    return `<button class="hist-card${cur}" data-h="${i}" title="${title}">${faces}<span class="hist-name">${title}</span></button>`;
  }).join('');
  $('#history-row').querySelectorAll('.hist-card').forEach((b) => b.addEventListener('click', () => {
    const h = rollHistory[Number(b.dataset.h)];
    if (h.mode !== currentMode) setMode(h.mode, { fresh: false });
    if (h.mode === 'solo') renderSolo(h.entry);
    else if (h.mode === 'duo') renderDuo(h.entry);
    else renderComp(h.entry);
  }));
}

/* ---- Renderers ------------------------------------------------------------ */
// Each renderer rolls from its pool, or renders `entry` when given
// (shared link, history restore, lock toggle refresh).
function renderSolo(entry) {
  let spicy = $('#solo-spice').value === 'spicy';
  let p = entry;
  if (p) {
    spicy = SPICY.includes(p);
    $('#solo-spice').value = spicy ? 'spicy' : 'classic';
  } else {
    const role = $('#role-filter').value;
    const src = spicy ? SPICY : CLASSIC;
    const pool = role === 'Any' ? src : src.filter((s) => s.role === role);
    if (!pool.length) {
      $('#result').innerHTML = `<p class="hint">No ${spicy ? 'spicy' : 'classic'} pick for that role yet — try another.</p>`;
      return;
    }
    p = pickNew(pool);
  }
  // Classic picks have no inline build — resolve from the shared libraries.
  const build = p.build || buildFor(p.id);
  const rune = runeFor(p.id, p.build);
  $('#result').innerHTML = `
    <div class="card">
      <span class="badge">${spicy ? '🌶️ ' : ''}${p.role}</span>
      <div class="champ">
        ${portrait(p.id)}
        <span class="champ-name">${champName(p.id)}</span>
      </div>
      <p class="why">${p.why}</p>
      ${buildBlock(build, null, rune)}
    </div>`;
  afterRoll('solo', p, spicy);
}

function renderDuo(entry) {
  let spicy = $('#duo-spice').value === 'spicy';
  let d = entry;
  if (d) {
    spicy = SPICY_DUOS.includes(d);
    $('#duo-spice').value = spicy ? 'spicy' : 'classic';
  } else {
    const base = spicy ? SPICY_DUOS : DUOS;
    d = pickNew(lockFilter(base, (e) => [e.adc, e.sup]));
  }
  const adcBuild = d.builds?.adc || BUILDS[d.adc];
  const supBuild = d.builds?.sup || BUILDS[d.sup];
  $('#result').innerHTML = `
    <div class="card">
      <span class="badge">${spicy ? '🌶️ ' : ''}${d.tag}</span>
      <div class="duo-row">
        <div ${lockable(d.adc)}>${portrait(d.adc)}<span class="champ-name">${champName(d.adc)}</span><span class="role-label">ADC</span></div>
        <span class="duo-x">+</span>
        <div ${lockable(d.sup)}>${portrait(d.sup)}<span class="champ-name">${champName(d.sup)}</span><span class="role-label">Support</span></div>
      </div>
      <p class="why">${d.why}</p>
      <div class="duo-builds">
        ${buildBlock(adcBuild, champName(d.adc), runeFor(d.adc, adcBuild))}
        ${buildBlock(supBuild, champName(d.sup), runeFor(d.sup, supBuild))}
      </div>
      ${lockHint(spicy ? SPICY_DUOS : DUOS, (e) => [e.adc, e.sup])}
    </div>`;
  attachLocks();
  afterRoll('duo', d, spicy);
}

function renderComp(entry) {
  const c = entry || pickNew(lockFilter(COMPS, (e) => e.champs.map((x) => x.id)));
  const champs = [...c.champs].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
  const roster = champs.map((x) =>
    `<div ${lockable(x.id)}>${portrait(x.id, true)}<span class="champ-name sm">${champName(x.id)}</span><span class="role-label">${x.role}</span></div>`
  ).join('');
  const steps = (c.play || []).map((s) => `<li>${s}</li>`).join('');
  $('#result').innerHTML = `
    <div class="card comp-card">
      <h2 class="comp-title">${c.name}</h2>
      ${c.spike ? `<span class="badge">Power spike · ${c.spike}</span>` : ''}
      <div class="comp-row">${roster}</div>
      ${c.overview ? `<p class="comp-overview">${c.overview}</p>` : ''}
      <div class="comp-section">
        <span class="label label--win">Win condition</span>
        <p>${c.winCon}</p>
      </div>
      ${steps ? `<div class="comp-section">
        <span class="label">How to play</span>
        <ul class="play-list">${steps}</ul>
      </div>` : ''}
      ${c.weakness ? `<div class="comp-section">
        <span class="label label--warn">⚠️ Countered by</span>
        <p>${c.weakness}</p>
      </div>` : ''}
      ${compBuilds(champs)}
      ${lockHint(COMPS, (e) => e.champs.map((x) => x.id))}
    </div>`;
  attachLocks();
  afterRoll('comp', c);
}

/* ---- Team Analyzer -------------------------------------------------------- */
const ROLES = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];
let team = { Top: null, Jungle: null, Mid: null, Bot: null, Support: null };
let activeRole = 'Top';
const currentTeam = () => ROLES.filter((r) => team[r]).map((r) => ({ role: r, id: team[r] }));

function traitsFor(id) {
  const c = CHAMP_TRAITS[id];
  if (c) return { dmg: c.dmg, traits: new Set(c.traits) };
  const cls = (CHAMPS[id] && CHAMPS[id].tags && CHAMPS[id].tags[0]) || 'Fighter';
  const fb = CLASS_FALLBACK[cls] || CLASS_FALLBACK.Fighter;
  return { dmg: fb.dmg, traits: new Set(fb.traits) };
}

function analyzeTeam(ids) {
  const infos = ids.map((id) => ({ id, ...traitsFor(id) }));
  const count = (t) => infos.filter((i) => i.traits.has(t)).length;
  const ad = infos.filter((i) => i.dmg === 'AD').length;
  const ap = infos.filter((i) => i.dmg === 'AP').length;
  const hybrid = infos.filter((i) => i.dmg === 'hybrid').length;
  const frontline = infos.filter((i) => i.dmg === 'tank' || i.traits.has('frontline')).length;
  const hardCC = count('cc');
  const engage = count('engage');
  const scaling = count('scaling');
  const early = count('early');

  // score every archetype from the team's aggregated traits, highest wins
  let best = ARCHETYPES[0], bestScore = -1;
  ARCHETYPES.forEach((a) => {
    let s = 0;
    infos.forEach((i) => i.traits.forEach((t) => { if (a.sig[t]) s += a.sig[t]; }));
    if (s > bestScore) { bestScore = s; best = a; }
  });

  let spike = 'Mid game';
  if (best.key === 'Scale & Outlast' || scaling >= 2) spike = 'Late game';
  else if (best.key === 'Early Snowball' || early >= 2) spike = 'Early game';

  const notes = [];
  if (frontline === 0) notes.push('No real frontline — your team is squishy and easy to dive. Play carefully around this.');
  if (hardCC <= 1) notes.push('Light on hard CC — you’ll struggle to lock down slippery targets.');
  if (!engage && !['Poke & Siege', 'Scale & Outlast', 'Split Push'].includes(best.key))
    notes.push('No hard engage — you rely on the enemy to commit first, so play for picks.');
  if (ad + hybrid >= 4 && ap === 0) notes.push('Almost all AD — one armor item (Thornmail / Randuin’s) blunts your whole team.');
  if (ap + hybrid >= 4 && ad === 0) notes.push('Almost all AP — one magic-resist item (Force of Nature / Kaenic) blunts your whole team.');
  if (count('poke') === 0 && count('waveclear') <= 1) notes.push('Low waveclear and poke — you can get sieged and zoned off objectives.');
  if (!notes.length) notes.push('Well-rounded — no glaring holes. Commit to your win condition and you’re favored.');

  return {
    archetype: best, spike, notes,
    dmgLabel: `${ad} AD · ${ap} AP${hybrid ? ` · ${hybrid} hyb` : ''}`,
    frontline, hardCC, engage: !!engage,
  };
}

function renderPlan(list) {
  if (list.length < 2) {
    $('#result').innerHTML = `<p class="hint">Fill at least 2 roles to generate a plan.</p>`;
    return;
  }
  const ordered = [...list].sort((x, y) => ROLE_ORDER[x.role] - ROLE_ORDER[y.role]);
  const ids = ordered.map((x) => x.id);
  const a = analyzeTeam(ids);
  const roster = ordered.map((x) =>
    `<div class="champ">${portrait(x.id, true)}<span class="champ-name sm">${champName(x.id)}</span><span class="role-label">${x.role}</span></div>`
  ).join('');
  const steps = a.archetype.play.map((s) => `<li>${s}</li>`).join('');
  const notes = a.notes.map((n) => `<li>${n}</li>`).join('');
  $('#result').innerHTML = `
    <div class="card comp-card">
      <h2 class="comp-title">${a.archetype.key}</h2>
      <span class="badge">Power spike · ${a.spike}</span>
      <div class="comp-row">${roster}</div>
      <div class="team-check">
        <span class="tc"><b>${a.dmgLabel}</b><i>damage</i></span>
        <span class="tc"><b>${a.frontline}</b><i>frontline</i></span>
        <span class="tc"><b>${a.hardCC}</b><i>hard CC</i></span>
        <span class="tc"><b>${a.engage ? 'Yes' : 'No'}</b><i>engage</i></span>
      </div>
      <div class="comp-section">
        <span class="label label--win">Win condition</span>
        <p>${a.archetype.winCon}</p>
      </div>
      <div class="comp-section">
        <span class="label">How to play</span>
        <ul class="play-list">${steps}</ul>
      </div>
      <div class="comp-section">
        <span class="label label--warn">⚠️ Watch out for</span>
        <ul class="play-list">${notes}</ul>
      </div>
      ${compBuilds(ordered)}
    </div>`;
}

// Build a champion grid into `grid`, calling onClick(id) on each pick.
function populateGrid(grid, onClick) {
  if (grid.dataset.built) return;
  const ids = Object.keys(CHAMPS).sort((x, y) => champName(x).localeCompare(champName(y)));
  if (!ids.length) return; // champs not loaded yet — try again on next tab open
  grid.innerHTML = ids.map((id) =>
    `<button class="champ-pick" data-id="${id}" title="${champName(id)}">
       <img src="${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png" alt="${champName(id)}" loading="lazy" />
       <span>${champName(id)}</span>
     </button>`
  ).join('');
  grid.dataset.built = '1';
  grid.querySelectorAll('.champ-pick').forEach((btn) =>
    btn.addEventListener('click', () => onClick(btn.dataset.id)));
}
function buildChampGrid() { populateGrid($('#champ-grid'), pickChamp); }

// Roles a champion can play: curated (traits or roles map) else inferred from class.
function rolesFor(id) {
  const t = CHAMP_TRAITS[id];
  if (t && t.roles) return t.roles;
  if (CHAMP_ROLES[id]) return CHAMP_ROLES[id];
  const cls = (CHAMPS[id] && CHAMPS[id].tags && CHAMPS[id].tags[0]) || 'Fighter';
  return CLASS_ROLES[cls] || ['Top'];
}

// Assign a champ to the active role slot (or remove it if already placed).
function pickChamp(id) {
  const placed = ROLES.find((r) => team[r] === id);
  if (placed) { team[placed] = null; activeRole = placed; syncPicker(); return; }
  team[activeRole] = id;
  const nextEmpty = ROLES.find((r) => !team[r]);
  if (nextEmpty) activeRole = nextEmpty;
  syncPicker();
}

// Click a role slot: clear it if filled, and make it the active slot.
function slotClick(role) {
  if (team[role]) team[role] = null;
  activeRole = role;
  syncPicker();
}

function syncPicker() {
  const tray = $('#team-tray');
  tray.innerHTML = ROLES.map((r) => {
    const id = team[r];
    const cls = `role-slot${r === activeRole ? ' is-active' : ''}${id ? ' filled' : ''}`;
    const body = id
      ? `<img src="${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png" alt="${champName(id)}" /><span class="slot-x">✕</span>`
      : `<span class="slot-plus">+</span>`;
    return `<button class="${cls}" data-role="${r}" title="${id ? champName(id) + ' — click to clear' : 'Pick a ' + r}">
        <span class="slot-role">${r}</span><span class="slot-body">${body}</span>
      </button>`;
  }).join('');
  tray.querySelectorAll('.role-slot').forEach((s) =>
    s.addEventListener('click', () => slotClick(s.dataset.role)));
  const placed = new Set(ROLES.map((r) => team[r]).filter(Boolean));
  $('#champ-grid').querySelectorAll('.champ-pick').forEach((b) =>
    b.classList.toggle('is-selected', placed.has(b.dataset.id)));
  $('#generate').disabled = placed.size < 2;
}

function roll() {
  if (currentMode === 'solo') renderSolo();
  else if (currentMode === 'duo') renderDuo();
  else renderComp();
}

/* ---- Draft Simulator ------------------------------------------------------ */
// Standard tournament draft order (B = Blue, R = Red).
const DRAFT_ORDER = [
  { t: 'B', k: 'ban' }, { t: 'R', k: 'ban' }, { t: 'B', k: 'ban' }, { t: 'R', k: 'ban' }, { t: 'B', k: 'ban' }, { t: 'R', k: 'ban' },
  { t: 'B', k: 'pick' }, { t: 'R', k: 'pick' }, { t: 'R', k: 'pick' }, { t: 'B', k: 'pick' }, { t: 'B', k: 'pick' }, { t: 'R', k: 'pick' },
  { t: 'R', k: 'ban' }, { t: 'B', k: 'ban' }, { t: 'R', k: 'ban' }, { t: 'B', k: 'ban' },
  { t: 'R', k: 'pick' }, { t: 'B', k: 'pick' }, { t: 'B', k: 'pick' }, { t: 'R', k: 'pick' },
];
let draftStep = 0, dBans = [], dBlue = [], dRed = [];

const coveredRoles = (picks) => {
  const cov = new Set();
  picks.forEach((id) => { const rs = rolesFor(id); cov.add(rs.find((r) => !cov.has(r)) || rs[0]); });
  return cov;
};
const neededRoles = (picks) => { const c = coveredRoles(picks); return ROLES.filter((r) => !c.has(r)); };
// Greedily assign each pick to a role, ordered Top→Support, for the build list.
function assignRoles(picks) {
  const cov = new Set(); const out = [];
  picks.forEach((id) => { const rs = rolesFor(id); const r = rs.find((x) => !cov.has(x)) || rs[0]; cov.add(r); out.push({ id, role: r }); });
  return out.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
}

function draftSuggest() {
  const step = DRAFT_ORDER[draftStep];
  if (!step) return [];
  const taken = new Set([...dBans, ...dBlue, ...dRed]);
  const pool = Object.keys(CHAMPS).filter((id) => !taken.has(id) && CHAMP_TRAITS[id]); // curated only, for quality

  if (step.k === 'ban') {
    return pool.map((id) => {
      const info = traitsFor(id), rs = rolesFor(id);
      return { id, score: info.traits.size + rs.length * 1.2, reason: rs.length > 1 ? 'flexible — deny it' : 'strong pick — deny it' };
    }).sort((a, b) => b.score - a.score).slice(0, 6);
  }

  const mine = step.t === 'B' ? dBlue : dRed;
  const enemy = step.t === 'B' ? dRed : dBlue;
  const need = neededRoles(mine);
  const mI = mine.map(traitsFor), eI = enemy.map(traitsFor);
  const mFront = mI.some((i) => i.dmg === 'tank' || i.traits.has('frontline'));
  const mEngage = mI.some((i) => i.traits.has('engage'));
  const mAP = mI.filter((i) => i.dmg === 'AP').length, mAD = mI.filter((i) => i.dmg === 'AD').length;
  const eAD = eI.filter((i) => i.dmg === 'AD' || i.dmg === 'hybrid').length;
  const eAP = eI.filter((i) => i.dmg === 'AP').length;
  const eEngage = eI.filter((i) => i.traits.has('engage')).length;
  const eFront = eI.filter((i) => i.dmg === 'tank' || i.traits.has('frontline')).length;

  return pool.map((id) => {
    const info = traitsFor(id), rs = rolesFor(id);
    let score = 0; const reasons = [];
    const roleFit = rs.find((r) => need.includes(r));
    if (need.length) score += roleFit ? 4 : -4;
    if (!mFront && (info.dmg === 'tank' || info.traits.has('frontline'))) { score += 3; reasons.push('adds a frontline'); }
    if (!mEngage && info.traits.has('engage')) { score += 3; reasons.push('adds engage'); }
    if (mine.length >= 2 && mAP === 0 && info.dmg === 'AP') { score += 2; reasons.push('adds magic damage'); }
    if (mine.length >= 2 && mAD === 0 && info.dmg === 'AD') { score += 2; reasons.push('adds physical damage'); }
    if (eAD >= 3 && (info.dmg === 'tank' || info.traits.has('frontline'))) { score += 2; reasons.push('armor vs their AD'); }
    if (eAP >= 3 && info.dmg === 'tank') { score += 2; reasons.push('MR vs their AP'); }
    if (eEngage >= 2 && info.traits.has('peel')) { score += 2; reasons.push('peel vs their engage'); }
    if (enemy.length >= 2 && eFront <= 1 && (info.traits.has('dive') || info.traits.has('burst'))) { score += 2; reasons.push('dives their squishies'); }
    score += Math.min(info.traits.size, 3) * 0.15;
    const reason = [roleFit ? `fills ${roleFit}` : '', ...reasons].filter(Boolean).slice(0, 3).join(' · ') || 'solid pick';
    return { id, score, reason };
  }).sort((a, b) => b.score - a.score).slice(0, 6);
}

function draftPick(id) {
  if (draftStep >= DRAFT_ORDER.length) return;
  if ([...dBans, ...dBlue, ...dRed].includes(id)) return;
  const step = DRAFT_ORDER[draftStep];
  if (step.k === 'ban') dBans.push(id);
  else (step.t === 'B' ? dBlue : dRed).push(id);
  draftStep++;
  renderDraft();
}

function draftReset() {
  draftStep = 0; dBans = []; dBlue = []; dRed = [];
  renderDraft();
}

function pickSlots(picks, teamKey, step, done) {
  let html = '';
  for (let i = 0; i < 5; i++) {
    const id = picks[i];
    const active = !done && step.k === 'pick' && step.t === teamKey && i === picks.length;
    html += id
      ? `<div class="pk filled"><img src="${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png" alt="${champName(id)}" /><span>${champName(id)}</span></div>`
      : `<div class="pk${active ? ' active' : ''}"><span class="pk-empty">${active ? '?' : ''}</span></div>`;
  }
  return html;
}

function renderDraft() {
  const done = draftStep >= DRAFT_ORDER.length;
  const step = DRAFT_ORDER[draftStep];
  const status = $('#draft-status');
  if (done) {
    status.innerHTML = `<span class="done">Draft complete</span>`;
  } else {
    const team = step.t === 'B' ? 'Blue' : 'Red';
    status.innerHTML = `<span class="turn ${step.t === 'B' ? 'blue' : 'red'}">${team}</span> to <b>${step.k === 'ban' ? 'ban' : 'pick'}</b>`;
  }
  $('#blue-picks').innerHTML = pickSlots(dBlue, 'B', step, done);
  $('#red-picks').innerHTML = pickSlots(dRed, 'R', step, done);
  let bans = '';
  for (let i = 0; i < 10; i++) {
    const id = dBans[i];
    const active = !done && step && step.k === 'ban' && i === dBans.length;
    bans += id
      ? `<div class="ban filled"><img src="${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png" alt="${champName(id)}" /></div>`
      : `<div class="ban${active ? ' active' : ''}"></div>`;
  }
  $('#ban-list').innerHTML = bans;

  const sug = $('#draft-suggest');
  $('#draft-search').hidden = done;
  $('#draft-grid').hidden = done;
  if (done) {
    renderDraftResult(sug);
  } else {
    const list = draftSuggest();
    sug.innerHTML = `<div class="suggest-head">${step.k === 'ban' ? 'Suggested bans' : 'Suggested picks'}</div>
      <div class="suggest-row">${list.map((s) =>
        `<button class="suggest-card" data-id="${s.id}">
           <img src="${DDRAGON}/cdn/${VERSION}/img/champion/${s.id}.png" alt="${champName(s.id)}" />
           <span class="sc-name">${champName(s.id)}</span><span class="sc-reason">${s.reason}</span>
         </button>`).join('')}</div>`;
    sug.querySelectorAll('.suggest-card').forEach((c) => c.addEventListener('click', () => draftPick(c.dataset.id)));
  }

  const taken = new Set([...dBans, ...dBlue, ...dRed]);
  $('#draft-grid').querySelectorAll('.champ-pick').forEach((b) => b.classList.toggle('taken', taken.has(b.dataset.id)));
  renderSaved();
}

/* ---- Draft result: evaluate, declare a winner, game plans, save ------------ */
function evaluateTeam(ids, enemyIds) {
  const a = analyzeTeam(ids);
  const infos = ids.map(traitsFor);
  const ad = infos.filter((i) => i.dmg === 'AD' || i.dmg === 'hybrid').length;
  const ap = infos.filter((i) => i.dmg === 'AP').length;
  const has = (t) => infos.some((i) => i.traits.has(t));
  // Weights sum so a flawless, enemy-countering comp reaches 100; a solid core sits ~80.
  let score = 40;
  const strengths = [], weaknesses = [];
  if (ad >= 1 && ap >= 1) { score += 12; strengths.push('mixed AD/AP damage'); }
  else { score -= 10; weaknesses.push('one-dimensional damage'); }
  if (a.frontline >= 2) { score += 12; strengths.push('a strong frontline'); }
  else if (a.frontline === 1) { score += 6; strengths.push('a frontline'); }
  else { score -= 12; weaknesses.push('no frontline'); }
  if (a.engage) { score += 9; strengths.push('hard engage'); } else { score -= 6; weaknesses.push('no hard engage'); }
  if (a.hardCC >= 2) { score += 9; strengths.push('strong crowd control'); }
  else if (a.hardCC === 1) { score += 4; } else { score -= 6; weaknesses.push('almost no CC'); }
  if (has('scaling') || has('hypercarry')) { score += 7; strengths.push('a scaling late game'); } else { weaknesses.push('limited scaling'); }
  if (has('peel')) { score += 5; strengths.push('peel for the carry'); }
  if (has('poke') || has('waveclear')) { score += 5; strengths.push('waveclear & siege'); } else { weaknesses.push('weak waveclear'); }
  const eInfos = enemyIds.map(traitsFor);
  const eAD = eInfos.filter((i) => i.dmg === 'AD' || i.dmg === 'hybrid').length;
  const eEngage = eInfos.filter((i) => i.traits.has('engage')).length;
  if (eAD >= 3 && a.frontline >= 2) { score += 4; strengths.push('built to absorb their AD'); }
  if (eEngage >= 2 && has('peel')) { score += 4; strengths.push('peel to answer their engage'); }
  score = Math.max(10, Math.min(100, Math.round(score)));
  return { plan: a, score, strengths, weaknesses };
}

function teamEvalCard(side, ev) {
  const a = ev.plan;
  return `<div class="eval-card ${side === 'Blue' ? 'blue' : 'red'}">
      <div class="ec-head"><span class="ec-side">${side === 'Blue' ? 'Blue' : 'Red'}</span><span class="ec-score">${ev.score}<i>/100</i></span></div>
      <div class="ec-arch">${a.archetype.key} · ${a.spike}</div>
      <div class="ec-diag">${a.dmgLabel} · ${a.frontline} front · ${a.hardCC} CC · ${a.engage ? 'engage' : 'no engage'}</div>
      <div class="ec-sec"><b>Win:</b> ${a.archetype.winCon}</div>
      <div class="ec-sec"><b>Plan:</b><ul>${a.archetype.play.map((p) => `<li>${p}</li>`).join('')}</ul></div>
      ${ev.strengths.length ? `<div class="ec-tags good">＋ ${ev.strengths.slice(0, 3).join(', ')}</div>` : ''}
      ${ev.weaknesses.length ? `<div class="ec-tags bad">－ ${ev.weaknesses.slice(0, 3).join(', ')}</div>` : ''}
    </div>`;
}

function renderDraftResult(el) {
  const eB = evaluateTeam(dBlue, dRed);
  const eR = evaluateTeam(dRed, dBlue);
  const diff = Math.abs(eB.score - eR.score);
  let banner;
  if (diff === 0) {
    banner = `<div class="verdict">A <b>dead-even</b> draft <span class="v-score">${eB.score}–${eR.score}</span>
      <div class="v-reason">Both comps are equally balanced — this one comes down to play.</div></div>`;
  } else {
    const winner = eB.score > eR.score ? 'Blue' : 'Red';
    const winEv = winner === 'Blue' ? eB : eR;
    const loseEv = winner === 'Blue' ? eR : eB;
    const loser = winner === 'Blue' ? 'Red' : 'Blue';
    const margin = diff < 6 ? 'narrowly' : diff < 14 ? 'clearly' : 'decisively';
    const edge = winEv.strengths.find((s) => !loseEv.strengths.includes(s));
    const reason = loseEv.weaknesses[0]
      ? `${loser} has ${loseEv.weaknesses[0]}`
      : edge ? `${winner} brings ${edge}` : `${winner} is the better-rounded composition`;
    banner = `<div class="verdict ${winner === 'Blue' ? 'blue' : 'red'}">
        <b>${winner}</b> wins the draft ${margin}
        <span class="v-score">${eB.score}–${eR.score}</span>
        <div class="v-reason">${reason}.</div></div>`;
  }
  const winner = eB.score >= eR.score ? 'Blue' : 'Red';
  el.innerHTML = `
    <div class="draft-result">
      ${banner}
      <div class="eval-cards">
        ${teamEvalCard('Blue', eB)}
        ${teamEvalCard('Red', eR)}
      </div>
      <div class="result-builds">
        ${compBuilds(assignRoles(dBlue), 'Blue: builds & skills')}
        ${compBuilds(assignRoles(dRed), 'Red: builds & skills')}
      </div>
      <div class="result-actions">
        <button id="draft-save" class="btn-primary">Save draft</button>
        <button id="draft-new" class="btn-ghost">↺ New draft</button>
      </div>
      <p class="picker-hint">Saved drafts are stored in this browser only.</p>
    </div>`;
  el.querySelector('#draft-save').addEventListener('click', () => saveDraft(winner, `${eB.score}–${eR.score}`));
  el.querySelector('#draft-new').addEventListener('click', draftReset);
}

/* ---- Saved drafts (browser localStorage) ---------------------------------- */
const DRAFT_KEY = 'lob_drafts';
const savedDrafts = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch { return []; } };
function saveDraft(winner, score) {
  const drafts = savedDrafts();
  drafts.unshift({ id: Date.now(), bans: [...dBans], blue: [...dBlue], red: [...dRed], winner, score, patch: VERSION });
  localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts.slice(0, 50)));
  renderSaved();
}
function deleteDraft(id) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(savedDrafts().filter((d) => d.id !== id)));
  renderSaved();
}
function loadDraft(d) {
  dBans = [...d.bans]; dBlue = [...d.blue]; dRed = [...d.red]; draftStep = DRAFT_ORDER.length;
  renderDraft();
  $('#draft').scrollIntoView({ block: 'start' });
}
function renderSaved() {
  const el = $('#saved-drafts');
  if (!el) return;
  const drafts = savedDrafts();
  if (!drafts.length) { el.innerHTML = ''; return; }
  const icons = (ids) => ids.map((id) => `<img src="${DDRAGON}/cdn/${VERSION}/img/champion/${id}.png" title="${champName(id)}" alt="${champName(id)}" />`).join('');
  el.innerHTML = `<div class="saved-head">Saved drafts (${drafts.length})</div>` +
    drafts.map((d) => `<div class="saved-row">
        <span class="sv-win ${d.winner === 'Blue' ? 'blue' : 'red'}">${d.winner} ${d.score || ''}</span>
        <span class="sv-teams">${icons(d.blue)}<b class="sv-vs">vs</b>${icons(d.red)}</span>
        <button class="sv-load" data-id="${d.id}">Load</button>
        <button class="sv-del" data-id="${d.id}" title="Delete">✕</button>
      </div>`).join('');
  el.querySelectorAll('.sv-load').forEach((b) => b.addEventListener('click', () => loadDraft(drafts.find((d) => d.id === Number(b.dataset.id)))));
  el.querySelectorAll('.sv-del').forEach((b) => b.addEventListener('click', () => deleteDraft(Number(b.dataset.id))));
}

/* ---- Wiring --------------------------------------------------------------- */
// `fresh: false` switches the mode UI without rolling — used when a shared
// link or a history card supplies the exact roll to render.
function setMode(mode, { fresh = true } = {}) {
  currentMode = mode;
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.mode === mode;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  const isAnalyzer = mode === 'analyzer';
  const isDraft = mode === 'draft';
  locks.clear();
  $('#solo-controls').hidden = mode !== 'solo';
  $('#duo-controls').hidden = mode !== 'duo';
  $('#analyzer').hidden = !isAnalyzer;
  $('#draft').hidden = !isDraft;
  $('#result').hidden = isDraft;
  document.querySelector('.actions').hidden = isAnalyzer || isDraft;
  renderHistory();
  if (isAnalyzer) {
    buildChampGrid();
    syncPicker();
    $('#share').hidden = true;
    $('#result').innerHTML = `<p class="hint">Pick your champions, then generate a game plan.</p>`;
  } else if (isDraft) {
    populateGrid($('#draft-grid'), draftPick);
    renderDraft();
  } else if (fresh) {
    roll(); // instant fresh roll when switching modes
  }
}
document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => setMode(tab.dataset.mode)));

$('#roll').addEventListener('click', roll);
$('#role-filter').addEventListener('change', () => { if (currentMode === 'solo') renderSolo(); });
$('#solo-spice').addEventListener('change', () => { if (currentMode === 'solo') renderSolo(); });
$('#duo-spice').addEventListener('change', () => { if (currentMode === 'duo') { locks.clear(); renderDuo(); } });

$('#share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    const btn = $('#share');
    const label = btn.textContent;
    btn.textContent = 'Link copied';
    setTimeout(() => (btn.textContent = label), 1400);
  } catch { /* clipboard blocked — no-op */ }
});
$('#generate').addEventListener('click', () => renderPlan(currentTeam()));
$('#champ-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  $('#champ-grid').querySelectorAll('.champ-pick').forEach((b) => {
    b.hidden = q && !champName(b.dataset.id).toLowerCase().includes(q);
  });
});
$('#draft-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  $('#draft-grid').querySelectorAll('.champ-pick').forEach((b) => {
    b.hidden = q && !champName(b.dataset.id).toLowerCase().includes(q);
  });
});
$('#draft-reset').addEventListener('click', draftReset);

boot();

/* Isolation entre plans : 10 km et Hyrox partagent la table `sessions` et
 * les mêmes session_id ("3_2"). Seuls le plan_id côté serveur et le préfixe
 * localStorage les séparent — une fuite ferait cocher une séance du 10 km
 * depuis le tracker Hyrox, ou l'inverse.
 *
 * Couvre : clés localStorage par plan (et rétrocompatibilité stricte des clés
 * 10 km sans configuration), plan_id des lignes poussées, filtre de la lecture
 * initiale et du canal realtime, et le tracker Hyrox lui-même (dates, semaines
 * Maroc sans volume, jauge sans NaN).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SYNC = fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8')
  .replace(/url: '[^']*',/, "url: 'https://test.supabase.co',")
  .replace(/key: '[^']*',/, "key: 'test-key',");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       attendu ' + e + '\n       obtenu  ' + a); }
}

/* Faux client qui enregistre les filtres demandés, contrairement à celui de
 * sync.test.js : c'est précisément ce qu'on vérifie ici. */
function makeEnv(opts) {
  const store = Object.assign({}, opts.storage || {});
  const calls = { eq: [], upserts: [], channels: [], handlers: [] };

  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };

  const query = {
    select() { return this; },
    eq(col, val) { calls.eq.push([col, val]); return Promise.resolve({ data: opts.remoteRows || [], error: null }); },
    upsert(payload) { calls.upserts.push(payload); return Promise.resolve({ data: null, error: null }); }
  };

  const client = {
    from: () => Object.create(query),
    channel: name => {
      calls.channels.push(name);
      return {
        on(type, filter, handler) { calls.handlers.push({ type, filter, handler }); return this; },
        subscribe() { return this; }
      };
    },
    removeChannel() { },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: {} } } }),
      onAuthStateChange: () => { },
      signInWithPassword: () => Promise.resolve({ error: null }),
      signOut: () => Promise.resolve({})
    }
  };

  const win = { supabase: { createClient: () => client }, addEventListener: () => { } };
  if (opts.plan !== undefined) win.TRACKER_PLAN = opts.plan;

  const sandbox = {
    window: win, localStorage, navigator: { onLine: true },
    setTimeout, clearTimeout, Promise, Date, JSON, Object,
    console: { log() { }, warn() { }, error() { } }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SYNC, sandbox);
  return { win, store, calls };
}

async function boot(opts) {
  const env = makeEnv(opts);
  let state = JSON.parse(JSON.stringify(opts.localState || {}));
  await env.win.TrackerSync.init({
    getState: () => state,
    onRemote: next => { state = next; },
    onStatus: () => { }
  });
  return { env, state: () => state };
}

const HYROX = { planId: 'christine-hyrox', storagePrefix: 'trackerHyrox_christine' };
const OLD_ISO = new Date(Date.now() - 60000).toISOString();
const NEW_ISO = new Date(Date.now() + 60000).toISOString();

(async () => {
  console.log('\n1. Sans TRACKER_PLAN : le 10 km strictement inchangé');
  {
    const { env } = await boot({ localState: { '3_2': { done: 1 } } });
    const p = env.win.TrackerSync.plan;
    check('plan_id par défaut', p.planId, 'christine-10k');
    check('clé meta historique', p.metaKey, 'tracker10k_christine_meta');
    check('clé outbox historique', p.outboxKey, 'tracker10k_christine_outbox');
    check('lecture filtrée par plan', env.calls.eq, [['plan_id', 'christine-10k']]);
    check('canal realtime filtré par plan', env.calls.handlers[0].filter.filter, 'plan_id=eq.christine-10k');
    check('nom de canal', env.calls.channels, ['sessions-christine-10k']);
    check('ligne poussée avec le plan 10 km', env.calls.upserts.flat().map(r => [r.plan_id, r.session_id]),
      [['christine-10k', '3_2']]);
    check('meta écrite sous la clé historique', 'tracker10k_christine_meta' in env.store, true);
    check('aucune clé Hyrox créée', Object.keys(env.store).some(k => /hyrox/i.test(k)), false);
  }

  console.log('\n2. Une file d\'attente 10 km existante est toujours relue');
  {
    const { env } = await boot({
      localState: { '4_0': { done: 1 } },
      storage: {
        tracker10k_christine_meta: JSON.stringify({ '4_0': Date.now() }),
        tracker10k_christine_outbox: JSON.stringify({ '4_0': true })
      },
      remoteRows: [{ session_id: '4_0', done: false, note: null, distance_km: null, scheduled_on: null, updated_at: OLD_ISO }]
    });
    check('le clic hors-ligne 10 km est repoussé', env.calls.upserts.flat().map(r => [r.plan_id, r.session_id, r.done]),
      [['christine-10k', '4_0', true]]);
  }

  console.log('\n3. Avec TRACKER_PLAN Hyrox : clés et plan_id distincts');
  {
    const tenK = {
      tracker10k_christine_meta: JSON.stringify({ '3_2': 1 }),
      tracker10k_christine_outbox: JSON.stringify({ '3_2': true })
    };
    const { env } = await boot({ plan: HYROX, localState: { '0_1': { done: 1 } }, storage: tenK });
    const p = env.win.TrackerSync.plan;
    check('plan_id Hyrox', p.planId, 'christine-hyrox');
    check('clé meta Hyrox', p.metaKey, 'trackerHyrox_christine_meta');
    check('clé outbox Hyrox', p.outboxKey, 'trackerHyrox_christine_outbox');
    check('lecture filtrée sur Hyrox', env.calls.eq, [['plan_id', 'christine-hyrox']]);
    check('canal realtime filtré sur Hyrox', env.calls.handlers[0].filter.filter, 'plan_id=eq.christine-hyrox');
    check('nom de canal distinct', env.calls.channels, ['sessions-christine-hyrox']);
    // Seule la séance Hyrox part : l'outbox 10 km ("3_2") n'est pas relue.
    check('seule la séance Hyrox est poussée, avec son plan_id',
      env.calls.upserts.flat().map(r => [r.plan_id, r.session_id]), [['christine-hyrox', '0_1']]);
    check('file d\'attente 10 km intacte', env.store.tracker10k_christine_outbox, tenK.tracker10k_christine_outbox);
    check('meta 10 km intacte', env.store.tracker10k_christine_meta, tenK.tracker10k_christine_meta);
    check('pendingCount ne compte que Hyrox', env.win.TrackerSync.pendingCount(), 0);
  }

  console.log('\n4. TRACKER_PLAN invalide ou partiel : repli intégral sur le 10 km');
  {
    for (const [label, plan] of [
      ['planId seul', { planId: 'christine-hyrox' }],
      ['préfixe seul', { storagePrefix: 'trackerHyrox_christine' }],
      ['planId vide', { planId: '', storagePrefix: 'x' }],
      ['caractères interdits', { planId: 'a,b', storagePrefix: 'p' }],
      ['pas un objet', 'christine-hyrox']
    ]) {
      const env = makeEnv({ plan });
      const p = env.win.TrackerSync.plan;
      check(label + ' → plan et clés 10 km', [p.planId, p.metaKey, p.outboxKey],
        ['christine-10k', 'tracker10k_christine_meta', 'tracker10k_christine_outbox']);
    }
  }

  console.log('\n5. Realtime : un événement d\'un autre plan est ignoré');
  {
    const { env, state } = await boot({ plan: HYROX, localState: { '3_2': { done: 1, note: 'hyrox' } } });
    const handler = env.calls.handlers[0].handler;
    handler({ new: { plan_id: 'christine-10k', session_id: '3_2', done: false, note: null, distance_km: null, scheduled_on: null, updated_at: NEW_ISO } });
    check('séance Hyrox 3_2 inchangée', state(), { '3_2': { done: 1, note: 'hyrox' } });
    handler({ new: { plan_id: 'christine-hyrox', session_id: '3_2', done: true, note: 'à jour', distance_km: null, scheduled_on: null, updated_at: NEW_ISO } });
    check('événement du bon plan appliqué', state(), { '3_2': { done: 1, note: 'à jour' } });
    handler({ new: {} });   // DELETE : payload.new vide
    check('événement vide sans effet', state(), { '3_2': { done: 1, note: 'à jour' } });
  }

  console.log('\n6. Pages : le 10 km ne déclare aucun plan, Hyrox déclare le sien');
  const TEN = fs.readFileSync(path.join(ROOT, 'Christine_10K_Tracker.html'), 'utf8');
  const HX = fs.readFileSync(path.join(ROOT, 'Christine_Hyrox_Tracker.html'), 'utf8');
  check('10 km : pas de TRACKER_PLAN (donc plan par défaut)', /TRACKER_PLAN\s*=/.test(TEN), false);
  check('10 km : clé locale historique', /var KEY = "tracker10k_christine";/.test(TEN), true);
  check('Hyrox : aucune référence au plan ou aux clés 10 km', /christine-10k|tracker10k/.test(HX), false);
  const decl = HX.indexOf('window.TRACKER_PLAN'), syncTag = HX.indexOf('<script src="sync.js">');
  check('Hyrox : plan déclaré avant sync.js', decl > 0 && decl < syncTag, true);

  console.log('\n7. Tracker Hyrox : préfixe du script évalué');
  const scripts = [...HX.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const planScript = scripts.find(s => s.includes('TRACKER_PLAN ='));
  const main = scripts.find(s => s.includes('var W = ['));
  const cut = main.indexOf('var grid = document.getElementById');
  if (cut < 0) throw new Error('point de coupe introuvable dans le tracker Hyrox');

  function loadHyrox(fixedToday, stored) {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(fixedToday.getTime()); }
      static now() { return fixedToday.getTime(); }
    }
    const store = Object.assign({}, stored || {});
    const sandbox = {
      Date: fixedToday ? FakeDate : Date, String, Number, JSON, Object, Math, console,
      localStorage: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
      },
      window: {}
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(planScript, sandbox);
    vm.runInContext(main.slice(0, cut), sandbox);
    return { sandbox, store };
  }

  {
    const { sandbox, store } = loadHyrox(null, {
      tracker10k_christine: JSON.stringify({ '0_0': { done: 1 } }),
      trackerHyrox_christine: JSON.stringify({ '1_2': 1 })
    });
    const { W, WEEK_STARTS, RACE_DAY, plannedDate, toISODate } = sandbox;
    check('clé locale Hyrox', sandbox.KEY, 'trackerHyrox_christine');
    check('état lu depuis la clé Hyrox (et migré), pas celle du 10 km', sandbox.state, { '1_2': { done: 1 } });
    check('progression 10 km non touchée', store.tracker10k_christine, JSON.stringify({ '0_0': { done: 1 } }));
    check('18 semaines', [W.length, WEEK_STARTS.length], [18, 18]);
    check('premier lundi', toISODate(WEEK_STARTS[0]), '2026-10-05');
    check('dernier lundi', toISODate(WEEK_STARTS[17]), '2027-02-01');
    check('tous des lundis', WEEK_STARTS.every(d => d.getDay() === 1), true);
    check('jour J : samedi 6 février 2027', [toISODate(RACE_DAY), RACE_DAY.getDay()], ['2027-02-06', 6]);
    check('totaux de semaine entiers', W.every(w => /^\d+$/.test(w[2])), true);
    check('S5 et S6 à 0 km', [W[4][2], W[5][2]], ['0', '0']);

    let bad = [], missing = [];
    W.forEach((w, wi) => w[5].forEach((s, si) => {
      const d = plannedDate(wi, s[0]);
      if (!d) { missing.push(wi + '_' + si); return; }
      const m = s[0].match(/(\d+)/);
      if (m && d.getDate() !== Number(m[1])) bad.push(wi + '_' + si + ' ' + s[0]);
    }));
    check('étiquettes datées sur le bon quantième', bad, []);
    check('toute séance a une date (Maroc compris)', missing, []);
    const race = W[17][5].find(s => /HYROX DOUBLES MIXTE/.test(s[1]));
    check('l\'épreuve tombe le jour J', toISODate(plannedDate(17, race[0])), '2027-02-06');
  }

  console.log('\n8. Jauge et prochain jalon pendant le Maroc (S5-S6) : pas de NaN');
  {
    const fns = ['esc', 'fmtKm', 'paintVolume'].map(name => {
      const start = main.indexOf('function ' + name + '(');
      if (start < 0) throw new Error(name + ' introuvable');
      let depth = 0, i = main.indexOf('{', start);
      for (; i < main.length; i++) {
        if (main[i] === '{') depth++;
        else if (main[i] === '}' && --depth === 0) break;
      }
      return main.slice(start, i + 1);
    }).join('\n');

    for (const [label, day] of [['S5, Maroc', new Date(2026, 10, 4)], ['S6, Maroc', new Date(2026, 10, 12)], ['avant le début', new Date(2026, 9, 1)]]) {
      const { sandbox } = loadHyrox(day, {});
      const els = {};
      const el = () => ({ hidden: false, textContent: '', innerHTML: '', style: {}, setAttribute(k, v) { this[k] = v; } });
      ['volume', 'vol-val', 'vol-fill', 'vol-meter', 'vol-next'].forEach(id => { els[id] = el(); });
      sandbox.document = { getElementById: id => els[id] || null };
      // Reconstitue SESSIONS / ALL_IDS comme la boucle de rendu de la page.
      vm.runInContext(`
        var ALL_IDS = [], SESSIONS = {};
        W.forEach(function (w, wi) { w[5].forEach(function (s, si) {
          var id = wi + '_' + si; ALL_IDS.push(id);
          SESSIONS[id] = { wi: wi, si: si, day: s[0], label: s[1], key: !!s[3],
            km: s[2] ? Number(s[2]) : null, planned: plannedDate(wi, s[0]) };
        }); });
        // Une option Maroc cochée, sans distance : ne doit rien casser.
        state['4_1'] = { done: 1 };
        ${fns}
        paintVolume();`, sandbox);
      const txt = [els['vol-val'].innerHTML, els['vol-fill'].style.width, els['vol-meter']['aria-label'], els['vol-next'].innerHTML].join(' | ');
      check(label + ' : aucun NaN / Infinity', /NaN|Infinity|undefined/.test(txt), false);
      check(label + ' : jauge bornée', /^\d+%$/.test(els['vol-fill'].style.width || '0%'), true);
      if (label !== 'avant le début') {
        check(label + ' : prochain jalon = côtes S8', /Côtes 10 × 30″/.test(els['vol-next'].innerHTML), true);
      } else {
        check(label + ' : prochain jalon = test VMA', /TEST VMA demi-Cooper/.test(els['vol-next'].innerHTML), true);
      }
    }
  }

  console.log('\n' + pass + ' assertions passées, ' + fail + ' échecs');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

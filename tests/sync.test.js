/* Harness de test pour sync.js — faux localStorage, faux client Supabase.
 *
 * Couvre la réconciliation local/distant, seule partie capable de corrompre
 * silencieusement la progression. Depuis les annotations, une séance n'est
 * plus un booléen mais { done, note, km, date } : les scénarios vérifient que
 * la fusion porte sur l'enregistrement entier, pas seulement sur `done`.
 */
const fs = require('fs');
const path = require('path');

// Le fichier livré porte la vraie config : on la neutralise pour les tests.
const SYNC = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8')
  .replace(/url: '[^']*',/, "url: 'https://test.supabase.co',")
  .replace(/key: '[^']*',/, "key: 'test-key',");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       attendu ' + e + '\n       obtenu  ' + a); }
}

function makeEnv(opts) {
  const store = Object.assign({}, opts.storage || {});
  const upserts = [];

  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };

  const query = {
    select() { return this; },
    eq() { return Promise.resolve({ data: opts.remoteRows || [], error: null }); },
    upsert(payload) { upserts.push(payload); return Promise.resolve({ data: null, error: null }); }
  };

  const client = {
    from: () => Object.create(query),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() { },
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: {} } } }),
      onAuthStateChange: () => { },
      signInWithPassword: () => Promise.resolve({ error: null }),
      signOut: () => Promise.resolve({})
    }
  };

  const win = { supabase: { createClient: () => client }, addEventListener: () => { } };

  const sandbox = {
    window: win, localStorage, navigator: { onLine: true },
    setTimeout, clearTimeout, Promise, Date, JSON, Object, console
  };
  sandbox.globalThis = sandbox;

  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(SYNC, sandbox);

  return { win, store, upserts, localStorage };
}

function run(name, opts, assert) {
  console.log('\n' + name);
  const env = makeEnv(opts);
  let state = JSON.parse(JSON.stringify(opts.localState || {}));
  let remoteApplied = null;

  let conflicts = null;

  return env.win.TrackerSync.init({
    getState: () => state,
    onRemote: next => { remoteApplied = next; state = next; },
    onStatus: () => { },
    onConflict: list => { conflicts = list; }
  }).then(() => assert({
    env,
    state: () => state,
    remoteApplied: () => remoteApplied,
    conflicts: () => conflicts
  }));
}

const NOW = Date.now();
const OLD_ISO = new Date(NOW - 60000).toISOString();
const NEW_ISO = new Date(NOW + 60000).toISOString();

// Ligne serveur complète : PostgREST renvoie toujours toutes les colonnes.
const row = (id, over) => Object.assign(
  { session_id: id, done: false, note: null, distance_km: null, scheduled_on: null, updated_at: OLD_ISO },
  over
);

(async () => {
  // 1. Base vide côté serveur, progression locale existante → tout est poussé.
  await run('1. Premier démarrage : le local part vers le serveur', {
    localState: { '0_0': { done: 1 }, '0_1': { done: 1 } },
    remoteRows: []
  }, ({ env, state }) => {
    check('état local préservé', state(), { '0_0': { done: 1 }, '0_1': { done: 1 } });
    const sent = env.upserts.flat().sort((a, b) => a.session_id.localeCompare(b.session_id));
    check('2 séances poussées', sent.map(r => [r.session_id, r.done]), [['0_0', true], ['0_1', true]]);
  });

  // 2. Le serveur a une séance que le local ignore → elle est adoptée.
  await run('2. Séance cochée sur l\'autre appareil → adoptée', {
    localState: {},
    remoteRows: [row('2_1', { done: true, updated_at: NEW_ISO })]
  }, ({ state, remoteApplied }) => {
    check('onRemote appelé', remoteApplied() !== null, true);
    check('séance distante adoptée', state(), { '2_1': { done: 1 } });
  });

  // 3. Conflit : coché hors-ligne localement (récent) vs serveur périmé.
  await run('3. Clic hors-ligne récent bat une valeur serveur périmée', {
    localState: { '3_2': { done: 1 } },
    storage: {
      tracker10k_christine_meta: JSON.stringify({ '3_2': NOW }),
      tracker10k_christine_outbox: JSON.stringify({ '3_2': true })
    },
    remoteRows: [row('3_2', { done: false, updated_at: OLD_ISO })]
  }, ({ env, state }) => {
    check('le clic local est conservé', state(), { '3_2': { done: 1 } });
    check('et repoussé au serveur', env.upserts.flat().map(r => [r.session_id, r.done]), [['3_2', true]]);
  });

  // 4. Inverse : le serveur est plus récent → il gagne.
  await run('4. Serveur plus récent qu\'une mutation locale ancienne', {
    localState: { '4_0': { done: 1 } },
    storage: {
      tracker10k_christine_meta: JSON.stringify({ '4_0': NOW - 120000 }),
      tracker10k_christine_outbox: JSON.stringify({ '4_0': true })
    },
    remoteRows: [row('4_0', { done: false, updated_at: NEW_ISO })]
  }, ({ state }) => {
    check('le décochage distant gagne', state(), {});
  });

  // 5. Rien à faire : local et distant déjà d'accord.
  await run('5. Local et distant identiques → aucune écriture', {
    localState: { '1_0': { done: 1 } },
    storage: { tracker10k_christine_meta: JSON.stringify({ '1_0': NOW - 120000 }) },
    remoteRows: [row('1_0', { done: true })]
  }, ({ env, state, remoteApplied }) => {
    check('état inchangé', state(), { '1_0': { done: 1 } });
    check('onRemote non appelé', remoteApplied(), null);
    check('aucun upsert', env.upserts.flat().length, 0);
  });

  // ---- annotations ----

  // 6. Note, distance et date descendent du serveur.
  await run('6. Annotations distantes adoptées', {
    localState: {},
    remoteRows: [row('5_1', {
      done: true, note: 'Genou sensible', distance_km: '7.20', scheduled_on: '2026-08-29',
      updated_at: NEW_ISO
    })]
  }, ({ state }) => {
    check('enregistrement complet', state(), {
      '5_1': { done: 1, note: 'Genou sensible', km: 7.2, date: '2026-08-29' }
    });
  });

  // 7. Une séance non faite mais annotée doit exister côté serveur.
  await run('7. Annotation sans case cochée → poussée quand même', {
    localState: { '6_0': { done: 0, note: 'Reportée, pluie', date: '2026-09-02' } },
    remoteRows: []
  }, ({ env, state }) => {
    check('conservée localement', state(), { '6_0': { done: 0, note: 'Reportée, pluie', date: '2026-09-02' } });
    const sent = env.upserts.flat()[0];
    check('poussée avec ses champs', [sent.done, sent.note, sent.scheduled_on],
      [false, 'Reportée, pluie', '2026-09-02']);
    check('distance restée nulle', sent.distance_km, null);
  });

  // 8. Une note modifiée sur l'autre appareil remplace la locale.
  await run('8. Note distante plus récente remplace la locale', {
    localState: { '7_1': { done: 1, note: 'ancienne note' } },
    storage: { tracker10k_christine_meta: JSON.stringify({ '7_1': NOW - 120000 }) },
    remoteRows: [row('7_1', { done: true, note: 'note à jour', updated_at: NEW_ISO })]
  }, ({ state }) => {
    check('note remplacée', state(), { '7_1': { done: 1, note: 'note à jour' } });
  });

  // 9. Un enregistrement sans aucun écart au plan ne doit pas subsister.
  await run('9. Enregistrement vide → non conservé', {
    localState: { '8_0': { done: 1 } },
    storage: { tracker10k_christine_meta: JSON.stringify({ '8_0': NOW - 120000 }) },
    remoteRows: [row('8_0', { done: false, updated_at: NEW_ISO })]
  }, ({ state }) => {
    check('supprimé de l\'état', state(), {});
  });

  // 10. Décocher à distance ne doit pas emporter la note.
  await run('10. Décoché à distance, note conservée', {
    localState: { '9_2': { done: 1, note: 'sensations correctes' } },
    storage: { tracker10k_christine_meta: JSON.stringify({ '9_2': NOW - 120000 }) },
    remoteRows: [row('9_2', { done: false, note: 'sensations correctes', updated_at: NEW_ISO })]
  }, ({ state }) => {
    check('note survit au décochage', state(), { '9_2': { done: 0, note: 'sensations correctes' } });
  });

  // 11. Une note locale non envoyée écrasée par le serveur doit être signalée.
  await run('11. Note locale en attente écrasée → conflit signalé', {
    localState: { '2_0': { done: 1, note: 'ma version' } },
    storage: {
      tracker10k_christine_meta: JSON.stringify({ '2_0': NOW - 120000 }),
      tracker10k_christine_outbox: JSON.stringify({ '2_0': true })
    },
    remoteRows: [row('2_0', { done: true, note: 'sa version', updated_at: NEW_ISO })]
  }, ({ state, conflicts }) => {
    check('la version serveur est appliquée', state(), { '2_0': { done: 1, note: 'sa version' } });
    check('le conflit est remonté', conflicts(),
      [{ id: '2_0', local: 'ma version', remote: 'sa version' }]);
  });

  // 12. Une mise à jour distante ordinaire n'est pas un conflit : sans édition
  //     locale en attente, personne ne perd de texte.
  await run('12. Note distante sans édition locale → aucun conflit', {
    localState: { '2_1': { done: 1, note: 'ancienne' } },
    storage: { tracker10k_christine_meta: JSON.stringify({ '2_1': NOW - 120000 }) },
    remoteRows: [row('2_1', { done: true, note: 'nouvelle', updated_at: NEW_ISO })]
  }, ({ state, conflicts }) => {
    check('note mise à jour', state(), { '2_1': { done: 1, note: 'nouvelle' } });
    check('aucun conflit signalé', conflicts(), null);
  });

  // 13. Une case cochée écrasée ne déclenche pas d'alerte : rien de rédigé.
  await run('13. Case écrasée sans note → aucun conflit', {
    localState: { '2_2': { done: 1 } },
    storage: {
      tracker10k_christine_meta: JSON.stringify({ '2_2': NOW - 120000 }),
      tracker10k_christine_outbox: JSON.stringify({ '2_2': true })
    },
    remoteRows: [row('2_2', { done: false, updated_at: NEW_ISO })]
  }, ({ conflicts }) => {
    check('aucun conflit signalé', conflicts(), null);
  });

  console.log('\n' + pass + ' assertions passées, ' + fail + ' échecs');
  process.exit(fail ? 1 : 0);
})();

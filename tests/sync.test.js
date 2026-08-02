/* Harness de test pour sync.js — faux localStorage, faux client Supabase. */
const fs = require('fs');
const path = require('path');

// Le fichier livré a une config vide (à remplir par Benjamin) : on l'injecte ici.
const SYNC = fs.readFileSync(
  path.join(__dirname, '..', 'sync.js'), 'utf8'
).replace("url: '',", "url: 'https://test.supabase.co',")
 .replace("key: '',", "key: 'test-key',");

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
    removeChannel() {},
    auth: {
      getSession: () => Promise.resolve({ data: { session: { user: {} } } }),
      onAuthStateChange: () => {},
      signInWithOtp: () => Promise.resolve({ error: null }),
      signOut: () => Promise.resolve({})
    }
  };

  const win = {
    supabase: { createClient: () => client },
    addEventListener: () => {}
  };

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
  let state = Object.assign({}, opts.localState || {});
  let remoteApplied = null;

  return env.win.TrackerSync.init({
    getState: () => state,
    onRemote: next => { remoteApplied = next; state = next; },
    onStatus: () => {}
  }).then(() => assert({ env, state: () => state, remoteApplied: () => remoteApplied }));
}

const NOW = Date.now();
const OLD_ISO = new Date(NOW - 60000).toISOString();
const NEW_ISO = new Date(NOW + 60000).toISOString();

(async () => {
  // 1. Base vide côté serveur, progression locale existante → tout est poussé.
  await run('1. Premier démarrage : le local part vers le serveur', {
    localState: { '0_0': 1, '0_1': 1 },
    remoteRows: []
  }, ({ env, state }) => {
    check('état local préservé', state(), { '0_0': 1, '0_1': 1 });
    const sent = env.upserts.flat().sort((a, b) => a.session_id.localeCompare(b.session_id));
    check('2 séances poussées', sent.map(r => [r.session_id, r.done]), [['0_0', true], ['0_1', true]]);
  });

  // 2. Le serveur a une séance que le local ignore → elle est adoptée.
  await run('2. Séance cochée sur l\'autre appareil → adoptée', {
    localState: {},
    remoteRows: [{ session_id: '2_1', done: true, updated_at: NEW_ISO }]
  }, ({ state, remoteApplied }) => {
    check('onRemote appelé', remoteApplied() !== null, true);
    check('séance distante adoptée', state(), { '2_1': 1 });
  });

  // 3. Conflit : coché hors-ligne localement (récent) vs serveur périmé qui dit false.
  //    Le clic hors-ligne doit gagner et être repoussé.
  await run('3. Clic hors-ligne récent bat une valeur serveur périmée', {
    localState: { '3_2': 1 },
    storage: {
      tracker10k_christine_meta: JSON.stringify({ '3_2': NOW }),
      tracker10k_christine_outbox: JSON.stringify({ '3_2': true })
    },
    remoteRows: [{ session_id: '3_2', done: false, updated_at: OLD_ISO }]
  }, ({ env, state }) => {
    check('le clic local est conservé', state(), { '3_2': 1 });
    const sent = env.upserts.flat();
    check('et repoussé au serveur', sent.map(r => [r.session_id, r.done]), [['3_2', true]]);
  });

  // 4. Inverse : le serveur est plus récent que la mutation locale → le serveur gagne.
  await run('4. Serveur plus récent qu\'une mutation locale ancienne', {
    localState: { '4_0': 1 },
    storage: {
      tracker10k_christine_meta: JSON.stringify({ '4_0': NOW - 120000 }),
      tracker10k_christine_outbox: JSON.stringify({ '4_0': true })
    },
    remoteRows: [{ session_id: '4_0', done: false, updated_at: NEW_ISO }]
  }, ({ state }) => {
    check('le décochage distant gagne', state(), {});
  });

  // 5. Rien à faire : local et distant déjà d'accord.
  await run('5. Local et distant identiques → aucune écriture', {
    localState: { '1_0': 1 },
    storage: { tracker10k_christine_meta: JSON.stringify({ '1_0': NOW - 120000 }) },
    remoteRows: [{ session_id: '1_0', done: true, updated_at: OLD_ISO }]
  }, ({ env, state, remoteApplied }) => {
    check('état inchangé', state(), { '1_0': 1 });
    check('onRemote non appelé', remoteApplied(), null);
    check('aucun upsert', env.upserts.flat().length, 0);
  });

  console.log('\n' + pass + ' assertions passées, ' + fail + ' échecs');
  process.exit(fail ? 1 : 0);
})();

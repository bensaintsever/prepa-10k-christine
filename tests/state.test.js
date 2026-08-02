/* Vérifie la migration de l'état et la logique de saisie du tracker.
 *
 * La migration est le code le plus dangereux du projet : si elle échoue, une
 * progression déjà saisie est relue comme vide, puis effacée au premier
 * enregistrement — et propagée à la base. Elle n'était couverte par rien.
 *
 * La logique de saisie (`parseKm`, `normalizeMove`) a été sortie du
 * gestionnaire de la feuille pour être testable : c'est là qu'un
 * `type="number"` avalait « 7,2 » sans rien dire.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'Christine_10K_Tracker.html'), 'utf8'
);

const inline = HTML.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];
const cut = inline.indexOf('var grid = document.getElementById');
if (cut < 0) throw new Error("point de coupe introuvable — le tracker a changé de structure");
const PREFIX = inline.slice(0, cut);

/* Charge le préfixe du tracker avec un localStorage préchargé. */
function load(stored) {
  const store = Object.assign({}, stored || {});
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  const sandbox = { Date, String, Number, JSON, Object, console, localStorage, window: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PREFIX, sandbox);
  return { sandbox, store };
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       attendu ' + e + '\n       obtenu  ' + a); }
}

const KEY = 'tracker10k_christine';

console.log('\n1. Migration de l\'ancien format');
{
  const { sandbox, store } = load({ [KEY]: JSON.stringify({ '0_0': 1, '1_2': 1, '2_0': 0 }) });
  check('les séances cochées deviennent des enregistrements',
    sandbox.state, { '0_0': { done: 1 }, '1_2': { done: 1 } });
  check('un 0 est supprimé plutôt que conservé', sandbox.state['2_0'], undefined);
  check('le localStorage est réécrit au nouveau format',
    JSON.parse(store[KEY]), { '0_0': { done: 1 }, '1_2': { done: 1 } });
}

console.log('\n2. Un état déjà migré n\'est pas retouché');
{
  const already = { '3_1': { done: 1, note: 'ok', km: 7.2, date: '2026-08-30' } };
  const { sandbox } = load({ [KEY]: JSON.stringify(already) });
  check('conservé à l\'identique', sandbox.state, already);
}

console.log('\n3. Cas dégradés');
{
  check('stockage absent', load({}).sandbox.state, {});
  check('JSON corrompu', load({ [KEY]: '{pas du json' }).sandbox.state, {});
  check('format mixte ancien/nouveau',
    load({ [KEY]: JSON.stringify({ a: 1, b: { done: 1, note: 'n' } }) }).sandbox.state,
    { a: { done: 1 }, b: { done: 1, note: 'n' } });
}

console.log('\n4. Distance saisie');
{
  const { sandbox } = load({});
  const p = sandbox.parseKm;
  check('virgule française', p('7,2'), { value: 7.2 });
  check('point décimal', p('7.2'), { value: 7.2 });
  check('entier', p('8'), { value: 8 });
  check('espaces autour', p('  6,5  '), { value: 6.5 });
  check('champ vide', p(''), { empty: true });
  check('champ absent', p(undefined), { empty: true });
  check('texte', p('abc'), { error: true });
  check('unité collée', p('7,2 km'), { error: true });
  check('négatif', p('-3'), { error: true });
  check('hors bornes', p('1000'), { error: true });
  check('arrondi au dixième', p('7,26'), { value: 7.3 });
  check('zéro accepté', p('0'), { value: 0 });
}

console.log('\n5. Report de date');
{
  const { sandbox } = load({});
  const planned = sandbox.plannedDate(1, 'Dim.');       // 2026-08-02
  const n = sandbox.normalizeMove;
  check('date identique au plan → pas un report', n('2026-08-02', planned), null);
  check('date différente → report', n('2026-08-03', planned), '2026-08-03');
  check('champ vide', n('', planned), null);
  check('date antérieure acceptée', n('2026-07-30', planned), '2026-07-30');
}

console.log('\n' + pass + ' assertions passées, ' + fail + ' échecs');
process.exit(fail ? 1 : 0);

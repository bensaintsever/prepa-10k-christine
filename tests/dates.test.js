/* Vérifie la dérivation des dates de séance à partir des étiquettes du plan.
 *
 * Le plan n'écrit qu'un jour de semaine ("Mar.", "Jeu. 23"). `plannedDate()`
 * en déduit une date réelle, indispensable pour reporter une séance.
 * Quatorze étiquettes portent déjà un quantième : elles servent d'oracle.
 *
 * Le code testé est celui du tracker, pas une copie : on évalue le préfixe du
 * script inline, jusqu'au premier accès au DOM.
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

const sandbox = { Date, String, Number, JSON, Object, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(inline.slice(0, cut), sandbox);

const { W, WEEK_STARTS, RACE_DAY, plannedDate, toISODate, fromISODate } = sandbox;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log('  FAIL ' + name + '\n       attendu ' + e + '\n       obtenu  ' + a); }
}

console.log('\n1. Les étiquettes datées tombent sur le bon quantième');
let oracles = 0;
W.forEach((week, wi) => {
  week[5].forEach(sess => {
    const label = sess[0];
    const m = label.match(/(\d+)/);
    if (!m) return;
    oracles++;
    const d = plannedDate(wi, label);
    check('S' + wi + ' « ' + label + ' »', d && d.getDate(), Number(m[1]));
  });
});
console.log('   ' + oracles + ' étiquettes datées vérifiées');

console.log('\n2. Toute séance obtient une date');
let missing = [];
W.forEach((week, wi) => {
  week[5].forEach((sess, si) => {
    if (!plannedDate(wi, sess[0])) missing.push('S' + wi + '/' + si + ' « ' + sess[0] + ' »');
  });
});
check('aucune séance sans date', missing, []);

console.log('\n3. La course tombe bien le jour J');
const last = W[10][5][W[10][5].length - 1];
check('dernière séance de S10', toISODate(plannedDate(10, last[0])), toISODate(RACE_DAY));

console.log('\n4. Les dates restent dans leur semaine et sont croissantes');
W.forEach((week, wi) => {
  const start = WEEK_STARTS[wi];
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  let prev = null, ok = true, ordered = true;
  week[5].forEach(sess => {
    const d = plannedDate(wi, sess[0]);
    if (d < start || d > end) ok = false;
    if (prev && d < prev) ordered = false;
    prev = d;
  });
  check('S' + wi + ' dans la fenêtre de 7 jours', ok, true);
  check('S' + wi + ' ordre chronologique', ordered, true);
});

console.log('\n5. Aller-retour ISO');
const d = plannedDate(3, 'Jeu.');
check('toISODate → fromISODate', toISODate(fromISODate(toISODate(d))), toISODate(d));
check("format ISO à zéros significatifs", toISODate(new Date(2026, 8, 6)), '2026-09-06');

console.log('\n' + pass + ' assertions passées, ' + fail + ' échecs');
process.exit(fail ? 1 : 0);

/* Synchronisation Supabase du tracker 10 km · Christine · Octobre Rose 2026
 *
 * Principe : hors-ligne d'abord. localStorage reste la source d'affichage,
 * Supabase n'est qu'une couche de synchro par-dessus. Une séance cochée sans
 * réseau est mémorisée localement, mise en file d'attente, et poussée dès le
 * retour de la connexion. La PWA continue donc de fonctionner hors-ligne.
 *
 * Réconciliation : dernier écrivain gagne, séance par séance. Chaque mutation
 * locale est horodatée et comparée à `updated_at` côté serveur.
 */
(function () {
  'use strict';

  /* ======================================================================
   * CONFIGURATION — les deux seules valeurs à renseigner
   * Dashboard Supabase → Settings → API
   * ====================================================================== */
  var CONFIG = {
    url: 'https://hdrjoyrpczutjihnbbui.supabase.co',
    key: 'sb_publishable_gtta8ZCQUCqPEX696FtJ0g_UwDO3l9R',

    planId: 'christine-10k',
    authMode: 'password',    // 'password' (RLS variante B) ou 'anon' (variante A)
    realtime: true
  };

  /* ====================================================================== */

  var META_KEY = 'tracker10k_christine_meta';     // { "3_2": 1785658060000 }
  var OUTBOX_KEY = 'tracker10k_christine_outbox'; // { "3_2": true }

  var LS = null;
  try {
    var probe = '__sync_probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    LS = localStorage;
  } catch (e) { LS = null; }

  function readMap(key) {
    if (!LS) return {};
    try { return JSON.parse(LS.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeMap(key, value) {
    if (!LS) return;
    try { LS.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  var meta = readMap(META_KEY);
  var outbox = readMap(OUTBOX_KEY);

  var client = null;
  var host = null;          // callbacks fournis par la page
  var status = 'disabled';
  var channel = null;
  var flushTimer = null;

  /* ------------------------------------------------- forme d'un enregistrement
   * Une séance valait un booléen ; elle porte maintenant une note, une distance
   * réalisée et une date de report. Les champs absents signifient « conforme au
   * plan » : on ne stocke que ce qui s'écarte du prévu, localement comme côté
   * serveur. La réconciliation compare l'enregistrement entier. */

  function fromRow(row) {
    var rec = { done: row.done ? 1 : 0 };
    if (row.note) rec.note = row.note;
    if (row.distance_km !== null && row.distance_km !== undefined) rec.km = Number(row.distance_km);
    if (row.scheduled_on) rec.date = row.scheduled_on;
    return rec;
  }

  function toRow(id, rec) {
    rec = rec || {};
    return {
      plan_id: CONFIG.planId,
      session_id: id,
      done: !!rec.done,
      note: rec.note || null,
      distance_km: (rec.km === null || rec.km === undefined) ? null : rec.km,
      scheduled_on: rec.date || null
    };
  }

  /* Signature stable pour détecter un changement réel : les clés sont listées
   * explicitement, un JSON.stringify direct dépendrait de l'ordre d'insertion. */
  function sig(rec) {
    if (!rec) return '';
    return [
      rec.done ? 1 : 0,
      rec.note || '',
      (rec.km === null || rec.km === undefined) ? '' : rec.km,
      rec.date || ''
    ].join('');
  }

  /* Un enregistrement sans aucun écart au plan n'a pas à exister. */
  function isEmpty(rec) {
    return sig(rec) === sig({ done: 0 });
  }

  function setStatus(next, detail) {
    status = next;
    if (host && host.onStatus) host.onStatus(next, detail || null);
  }

  function isConfigured() {
    return !!(CONFIG.url && CONFIG.key && window.supabase);
  }

  /* ---------------------------------------------------------------- auth */

  function needsAuth() {
    return CONFIG.authMode === 'password';
  }

  function currentSession() {
    return client ? client.auth.getSession() : Promise.resolve({ data: { session: null } });
  }

  /* Mot de passe plutôt que magic link : le SMTP partagé de Supabase plafonne
   * à 2 mails par heure et n'est déverrouillable qu'avec un SMTP personnalisé.
   * Pour deux utilisateurs qui se connectent une fois, la dépendance au mail
   * coûtait plus qu'elle ne rapportait. */
  function signIn(email, password) {
    if (!client) return Promise.reject(new Error('Supabase non configuré'));
    setStatus('signing-in');

    return client.auth
      .signInWithPassword({ email: email, password: password })
      .then(function (res) {
        if (res.error) throw res.error;
        // onAuthStateChange enchaîne sur start() : rien à faire de plus ici.
        return res.data;
      })
      .catch(function (err) {
        var msg = err.message || String(err);

        if (/invalid login credentials/i.test(msg)) {
          msg = 'Adresse ou mot de passe incorrect.';
        } else if (/email not confirmed/i.test(msg)) {
          msg = 'Ce compte n\'est pas confirmé. Dans le dashboard Supabase, '
              + 'coche « Auto Confirm User » à la création.';
        } else if (/rate limit/i.test(msg)) {
          msg = 'Trop de tentatives rapprochées. Réessaie dans quelques minutes.';
        }

        // Statut distinct de 'error' : c'est la connexion qui échoue, pas la
        // synchro, et le panneau doit rester ouvert pour permettre un nouvel essai.
        setStatus('auth-error', msg);
        throw err;
      });
  }

  function signOut() {
    if (!client) return Promise.resolve();
    return client.auth.signOut().then(function () {
      teardownRealtime();
      setStatus('signed-out');
    });
  }

  /* -------------------------------------------------------------- réseau */

  var pulling = null;

  function pull() {
    if (!client) return Promise.resolve(null);
    // `getSession()` et `onAuthStateChange` se déclenchent tous deux au
    // chargement : sans ce garde-fou, deux pulls partiraient en parallèle.
    if (pulling) return pulling;

    setStatus('syncing');

    pulling = client
      .from('sessions')
      .select('session_id, done, note, distance_km, scheduled_on, updated_at')
      .eq('plan_id', CONFIG.planId)
      .then(function (res) {
        if (res.error) throw res.error;
        return reconcile(res.data || []);
      })
      .then(function (merged) {
        return flushOutbox().then(function () { return merged; });
      })
      .then(function (merged) {
        pulling = null;
        setStatus('synced');
        return merged;
      })
      .catch(function (err) {
        pulling = null;
        setStatus(navigator.onLine ? 'error' : 'offline', err.message || String(err));
        return null;
      });

    return pulling;
  }

  /* Fusionne l'état distant avec l'état local.
   * Une séance en attente d'envoi (outbox) dont la mutation locale est plus
   * récente que le serveur reste prioritaire : on ne réécrase pas un clic
   * fait hors-ligne avec une valeur serveur périmée. */
  function reconcile(rows) {
    var local = host.getState() || {};
    var next = {};
    var seen = {};
    var changed = false;
    var conflicts = [];

    rows.forEach(function (row) {
      var id = row.session_id;
      seen[id] = true;

      var remoteTs = Date.parse(row.updated_at) || 0;
      var localTs = meta[id] || 0;
      var localRec = local[id] || null;

      var keepLocal = outbox[id] && localTs > remoteTs;
      var rec = keepLocal ? localRec : fromRow(row);

      /* Écraser une case à cocher est sans gravité ; écraser un texte rédigé
       * l'est moins. On ne signale que le cas réellement perdant : une note
       * locale encore en attente d'envoi que le serveur remplace. */
      if (!keepLocal && outbox[id] && localRec && localRec.note
        && localRec.note !== (row.note || '')) {
        conflicts.push({ id: id, local: localRec.note, remote: row.note || '' });
      }

      if (rec && !isEmpty(rec)) next[id] = rec;
      if (sig(rec) !== sig(localRec)) changed = true;
      if (!keepLocal) meta[id] = remoteTs;
    });

    // Séances connues localement mais absentes du serveur : à pousser.
    Object.keys(local).forEach(function (id) {
      if (seen[id]) return;
      if (!isEmpty(local[id])) next[id] = local[id];
      outbox[id] = true;
    });

    writeMap(META_KEY, meta);
    writeMap(OUTBOX_KEY, outbox);

    if (changed && host.onRemote) host.onRemote(next);
    if (conflicts.length && host.onConflict) host.onConflict(conflicts);
    return next;
  }

  function flushOutbox() {
    var ids = Object.keys(outbox);
    if (!client || !ids.length) return Promise.resolve();

    var local = host.getState() || {};
    var payload = ids.map(function (id) {
      return toRow(id, local[id]);
    });

    return client
      .from('sessions')
      .upsert(payload, { onConflict: 'plan_id,session_id' })
      .then(function (res) {
        if (res.error) throw res.error;
        ids.forEach(function (id) { delete outbox[id]; });
        writeMap(OUTBOX_KEY, outbox);
      });
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      flushTimer = null;
      if (!client) return;
      flushOutbox()
        .then(function () { setStatus('synced'); })
        .catch(function (err) {
          setStatus(navigator.onLine ? 'error' : 'offline', err.message || String(err));
        });
    }, 400); // regroupe les clics rapprochés en un seul appel
  }

  /* ------------------------------------------------------------ realtime */

  function setupRealtime() {
    if (!CONFIG.realtime || !client || channel) return;

    channel = client
      .channel('sessions-' + CONFIG.planId)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sessions',
          filter: 'plan_id=eq.' + CONFIG.planId
        },
        function (payload) {
          var row = payload.new;
          if (!row || !row.session_id) return;

          // Ignore l'écho de nos propres écritures encore en file d'attente.
          if (outbox[row.session_id]) return;

          var local = host.getState() || {};
          var next = {};
          Object.keys(local).forEach(function (k) {
            if (!isEmpty(local[k])) next[k] = local[k];
          });

          var rec = fromRow(row);
          if (isEmpty(rec)) delete next[row.session_id];
          else next[row.session_id] = rec;

          meta[row.session_id] = Date.parse(row.updated_at) || Date.now();
          writeMap(META_KEY, meta);

          if (host.onRemote) host.onRemote(next);
        }
      )
      .subscribe();
  }

  function teardownRealtime() {
    if (channel && client) { client.removeChannel(channel); }
    channel = null;
  }

  /* ------------------------------------------------------------- démarrage */

  function start() {
    setupRealtime();
    return pull();
  }

  function init(hostApi) {
    host = hostApi;

    if (!isConfigured()) {
      setStatus('disabled');
      return Promise.resolve(null);
    }

    client = window.supabase.createClient(CONFIG.url, CONFIG.key, {
      auth: { persistSession: true, detectSessionInUrl: true }
    });

    window.addEventListener('online', function () { if (client) start(); });
    window.addEventListener('offline', function () { setStatus('offline'); });

    if (!needsAuth()) return start();

    client.auth.onAuthStateChange(function (event, session) {
      if (session) start();
      else { teardownRealtime(); setStatus('signed-out'); }
    });

    return currentSession().then(function (res) {
      if (res && res.data && res.data.session) return start();
      setStatus('signed-out');
      return null;
    });
  }

  /* ---------------------------------------------------------------- API */

  window.TrackerSync = {
    /* Déclare une mutation locale sur une séance et programme son envoi. */
    mark: function (sessionId, done) {
      meta[sessionId] = Date.now();
      outbox[sessionId] = true;
      writeMap(META_KEY, meta);
      writeMap(OUTBOX_KEY, outbox);
      scheduleFlush();
    },

    /* Remplacement en bloc (reset, import de fichier) : toutes les séances
     * connues sont marquées, y compris celles repassées à false. */
    markAll: function (allIds) {
      var now = Date.now();
      allIds.forEach(function (id) {
        meta[id] = now;
        outbox[id] = true;
      });
      writeMap(META_KEY, meta);
      writeMap(OUTBOX_KEY, outbox);
      scheduleFlush();
    },

    init: init,
    signIn: signIn,
    signOut: signOut,
    isConfigured: isConfigured,
    needsAuth: needsAuth,
    getStatus: function () { return status; },
    pendingCount: function () { return Object.keys(outbox).length; }
  };
})();

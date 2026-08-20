#!/usr/bin/env node
/**
 * Interface d'émission des clés d'activation.
 *
 *   pnpm licences
 *
 * OÙ VIT LA SÉCURITÉ, ET POURQUOI PAS AILLEURS :
 *
 * La clé privée signe toutes les licences. Qui la détient peut en émettre à
 * votre place, gratuitement, sans que vous le sachiez jamais. C'est donc elle,
 * et elle seule, qu'il faut protéger — et la meilleure protection est qu'elle
 * ne bouge pas de votre machine.
 *
 * D'où le refus d'une page dans le back-office : elle aurait supposé la clé
 * privée sur le serveur, c'est-à-dire sur une machine exposée à Internet et
 * partagée avec les données de vos clients. Une intrusion y aurait valu
 * émission illimitée de licences.
 *
 * Cet outil est donc un serveur LOCAL, qui n'écoute que la boucle locale, ne
 * répond qu'avec un jeton engendré à chaque démarrage, et s'éteint quand vous
 * fermez le terminal.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  CHEMIN_REGISTRE,
  EmissionError,
  LICENCE_FEATURES,
  LICENCE_SEGMENTS,
  chargerClePrivee,
  emettre,
  lireRegistre,
} from './lib/emission.mjs';

/* ─── Garde-fous ───────────────────────────────────────────────────────────*/

let privee;
try {
  privee = await chargerClePrivee();
} catch (erreur) {
  console.error(`\n  ${erreur instanceof EmissionError ? erreur.message : String(erreur)}\n`);
  process.exit(1);
}

/**
 * Jeton de session, engendré à chaque démarrage.
 *
 * La boucle locale n'est pas une frontière suffisante : une page web ouverte
 * dans votre navigateur peut envoyer des requêtes à `localhost` à votre insu.
 * Le jeton l'en empêche — elle ne peut pas le deviner, et sans lui rien ne
 * répond.
 */
const JETON = randomBytes(24).toString('base64url');

const jetonValide = (recu) => {
  if (typeof recu !== 'string' || recu.length !== JETON.length) return false;
  // Comparaison à temps constant : une comparaison ordinaire s'arrête au
  // premier caractère différent, ce qui laisse deviner le jeton signe à signe.
  return timingSafeEqual(Buffer.from(recu), Buffer.from(JETON));
};

/**
 * Refuse une requête dont l'en-tête `Host` n'est pas la boucle locale.
 *
 * Défense contre le « DNS rebinding » : un domaine qui résout vers 127.0.0.1
 * permettrait à une page distante de parler à ce serveur. L'en-tête `Host`
 * porterait alors ce domaine, et non `localhost`.
 */
const hoteLocal = (host) =>
  typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

/* ─── Page ─────────────────────────────────────────────────────────────────*/

const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clés d'activation — Caisse</title>
<style>
  :root { --encre:#1a1f2b; --gris:#6b7280; --bord:#e5e7eb; --bleu:#2563eb; --vert:#059669; --rouge:#b91c1c; }
  * { box-sizing:border-box; }
  body { margin:0; padding:2rem 1rem; font:15px/1.5 system-ui,sans-serif; color:var(--encre);
         background:#f6f7f9; }
  main { max-width:52rem; margin:0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .25rem; }
  .sous { color:var(--gris); margin:0 0 1.5rem; }
  .carte { background:#fff; border:1px solid var(--bord); border-radius:12px; padding:1.25rem;
           margin-bottom:1.25rem; }
  label { display:block; font-weight:600; font-size:.875rem; margin-bottom:.35rem; }
  .aide { font-weight:400; color:var(--gris); }
  input, select, textarea { width:100%; padding:.6rem .7rem; border:1px solid var(--bord);
           border-radius:8px; font:inherit; }
  input:focus, select:focus { outline:2px solid var(--bleu); outline-offset:-1px; }
  .grille { display:grid; gap:.9rem; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); }
  button { padding:.7rem 1.1rem; border-radius:8px; border:1px solid transparent; font:inherit;
           font-weight:600; cursor:pointer; }
  .principal { background:var(--bleu); color:#fff; }
  .principal:disabled { opacity:.45; cursor:default; }
  .discret { background:#fff; border-color:var(--bord); color:var(--encre); }
  .cle { font-family:ui-monospace,monospace; font-size:.75rem; word-break:break-all;
         background:#f0f4ff; border:1px solid #c7d7fe; border-radius:8px; padding:.8rem; }
  .erreur { background:#fef2f2; color:var(--rouge); border-radius:8px; padding:.7rem; }
  table { width:100%; border-collapse:collapse; font-size:.875rem; }
  th { text-align:left; color:var(--gris); font-weight:600; padding:.4rem 0; }
  td { padding:.5rem 0; border-top:1px solid var(--bord); vertical-align:top; }
  .pastille { display:inline-block; padding:.1rem .5rem; border-radius:999px; font-size:.75rem;
              font-weight:600; }
  .ok { background:#ecfdf5; color:var(--vert); }
  .bientot { background:#fffbeb; color:#92400e; }
  .fini { background:#fef2f2; color:var(--rouge); }
  .fonctions { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:.35rem; }
  .fonctions label { font-weight:400; display:flex; gap:.35rem; align-items:center; margin:0; }
  .fonctions input { width:auto; }
</style></head><body><main>
  <h1>Clés d'activation</h1>
  <p class="sous">Cet outil tourne sur votre machine. La clé privée n'en sort jamais.</p>

  <div class="carte">
    <div class="grille">
      <div>
        <label for="code">Code d'installation
          <span class="aide">— lu par le commerçant</span></label>
        <input id="code" placeholder="A1B2-C3D4-E5F6" autocomplete="off" spellcheck="false">
      </div>
      <div>
        <label for="nom">Nom du commerce</label>
        <input id="nom" placeholder="Épicerie Rakoto" autocomplete="off">
      </div>
      <div>
        <label for="segment">Segment</label>
        <select id="segment"></select>
      </div>
      <div>
        <label for="mois">Durée <span class="aide">(mois)</span></label>
        <input id="mois" type="number" min="1" max="120" value="12">
      </div>
      <div>
        <label for="caisses">Caisses autorisées</label>
        <input id="caisses" type="number" min="1" value="1">
      </div>
      <div>
        <label for="boutiques">Boutiques</label>
        <input id="boutiques" type="number" min="1" value="1">
      </div>
    </div>

    <div style="margin-top:1rem">
      <label>Fonctions ouvertes <span class="aide">— le segment les préremplit</span></label>
      <div class="fonctions" id="fonctions"></div>
    </div>

    <div style="margin-top:1rem">
      <label for="note">Note <span class="aide">(facultatif, pour votre registre)</span></label>
      <input id="note" placeholder="Payé en espèces, contact 034…">
    </div>

    <div style="margin-top:1.1rem;display:flex;gap:.6rem;align-items:center">
      <button class="principal" id="emettre">Émettre la clé</button>
      <span id="etat" class="aide"></span>
    </div>
  </div>

  <div class="carte" id="resultat" hidden>
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem">
      <strong id="resume"></strong>
      <button class="discret" id="copier">Copier</button>
    </div>
    <div class="cle" id="cle" style="margin-top:.7rem"></div>
  </div>

  <div class="carte">
    <div style="display:flex;justify-content:space-between;align-items:baseline">
      <strong>Clés émises</strong>
      <button class="discret" id="rafraichir">Actualiser</button>
    </div>
    <table style="margin-top:.6rem"><thead><tr>
      <th>Commerce</th><th>Installation</th><th>Segment</th><th>Expire</th><th></th>
    </tr></thead><tbody id="registre"></tbody></table>
  </div>
</main>
<script>
const JETON = new URLSearchParams(location.search).get('jeton') || '';
const $ = (id) => document.getElementById(id);

async function appel(chemin, options = {}) {
  const reponse = await fetch(chemin + '?jeton=' + encodeURIComponent(JETON), {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await reponse.json();
  if (!reponse.ok) throw new Error(data.erreur || 'Erreur');
  return data;
}

let SEGMENTS = {}, FONCTIONS = [];

function dessinerFonctions(cochees) {
  $('fonctions').innerHTML = FONCTIONS.map((f) =>
    '<label><input type="checkbox" value="' + f + '"' +
    (cochees.includes(f) ? ' checked' : '') + '>' + f + '</label>').join('');
}

function fonctionsChoisies() {
  return [...$('fonctions').querySelectorAll('input:checked')].map((i) => i.value);
}

$('segment').addEventListener('change', () => {
  dessinerFonctions(SEGMENTS[$('segment').value] || []);
});

$('emettre').addEventListener('click', async () => {
  $('etat').textContent = 'Signature…';
  $('emettre').disabled = true;
  try {
    const data = await appel('/api/emettre', { method: 'POST', body: {
      code: $('code').value, nom: $('nom').value, segment: $('segment').value,
      mois: Number($('mois').value), caisses: Number($('caisses').value),
      boutiques: Number($('boutiques').value), fonctions: fonctionsChoisies(),
      note: $('note').value,
    }});
    $('resultat').hidden = false;
    $('resume').textContent = data.payload.n + ' — valable jusqu\\'au ' + data.payload.e;
    $('cle').textContent = data.cle;
    $('etat').textContent = '';
    $('code').value = ''; $('nom').value = ''; $('note').value = '';
    await charger();
  } catch (erreur) {
    $('etat').innerHTML = '<span style="color:#b91c1c">' + erreur.message + '</span>';
  } finally {
    $('emettre').disabled = false;
  }
});

$('copier').addEventListener('click', () => {
  navigator.clipboard.writeText($('cle').textContent).then(() => {
    $('copier').textContent = 'Copié';
    setTimeout(() => { $('copier').textContent = 'Copier'; }, 1500);
  });
});

$('rafraichir').addEventListener('click', () => charger());

function etatEcheance(expireLe) {
  const jours = Math.ceil((Date.parse(expireLe + 'T23:59:59Z') - Date.now()) / 86400000);
  if (jours < 0) return ['fini', 'expirée'];
  if (jours <= 30) return ['bientot', jours + ' j'];
  return ['ok', jours + ' j'];
}

async function charger() {
  const data = await appel('/api/registre');
  $('registre').innerHTML = data.entrees.length === 0
    ? '<tr><td colspan="5" style="color:#6b7280">Aucune clé émise.</td></tr>'
    : data.entrees.map((e) => {
        const [classe, texte] = etatEcheance(e.expireLe);
        return '<tr><td><strong>' + e.nom + '</strong>' +
          (e.note ? '<br><span style="color:#6b7280;font-size:.8rem">' + e.note + '</span>' : '') +
          '</td><td style="font-family:ui-monospace,monospace">' + e.code + '</td>' +
          '<td>' + e.segment + '<br><span style="color:#6b7280;font-size:.8rem">' +
          e.caisses + ' caisse(s)</span></td>' +
          '<td>' + e.expireLe + '<br><span class="pastille ' + classe + '">' + texte + '</span></td>' +
          '<td><button class="discret" data-cle="' + e.cle + '">Copier</button></td></tr>';
      }).join('');

  $('registre').querySelectorAll('button[data-cle]').forEach((bouton) => {
    bouton.addEventListener('click', () => {
      navigator.clipboard.writeText(bouton.dataset.cle);
      bouton.textContent = 'Copié';
      setTimeout(() => { bouton.textContent = 'Copier'; }, 1500);
    });
  });
}

appel('/api/segments').then((data) => {
  SEGMENTS = data.segments; FONCTIONS = data.fonctions;
  $('segment').innerHTML = Object.keys(SEGMENTS)
    .map((s) => '<option value="' + s + '">' + s + '</option>').join('');
  dessinerFonctions(SEGMENTS[$('segment').value] || []);
  return charger();
}).catch((erreur) => {
  document.body.innerHTML = '<main><div class="carte erreur">' +
    'Jeton absent ou invalide. Ouvrez l\\'adresse affichée dans le terminal.</div></main>';
});
</script></body></html>`;

/* ─── Serveur ──────────────────────────────────────────────────────────────*/

const repondre = (res, code, corps) => {
  res.writeHead(code, {
    'Content-Type': typeof corps === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    // Aucun en-tête CORS : une page d'un autre site ne doit pas pouvoir lire
    // les réponses, même si elle devinait le jeton.
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(typeof corps === 'string' ? corps : JSON.stringify(corps));
};

const serveur = createServer(async (req, res) => {
  if (!hoteLocal(req.headers.host)) {
    return repondre(res, 403, { erreur: 'hôte non local' });
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!jetonValide(url.searchParams.get('jeton'))) {
    // La page elle-même est servie sans jeton valide, pour pouvoir afficher un
    // message compréhensible plutôt qu'une erreur brute.
    if (url.pathname === '/') return repondre(res, 200, PAGE);
    return repondre(res, 401, { erreur: 'jeton absent ou invalide' });
  }

  try {
    if (url.pathname === '/') return repondre(res, 200, PAGE);

    if (url.pathname === '/api/segments') {
      return repondre(res, 200, {
        segments: LICENCE_SEGMENTS,
        fonctions: [...LICENCE_FEATURES],
      });
    }

    if (url.pathname === '/api/registre') {
      return repondre(res, 200, { entrees: await lireRegistre() });
    }

    if (url.pathname === '/api/emettre' && req.method === 'POST') {
      const morceaux = [];
      for await (const morceau of req) morceaux.push(morceau);
      const demande = JSON.parse(Buffer.concat(morceaux).toString('utf8') || '{}');
      return repondre(res, 200, await emettre(demande, privee));
    }

    return repondre(res, 404, { erreur: 'inconnu' });
  } catch (erreur) {
    // Un refus attendu s'explique au commerçant ; un défaut imprévu reste dans
    // le terminal. Renvoyer une erreur interne au navigateur ne l'aiderait pas
    // et dirait à qui l'écoute comment cet outil est fait.
    if (erreur instanceof EmissionError) return repondre(res, 400, { erreur: erreur.message });
    console.error(erreur);
    return repondre(res, 500, { erreur: 'Défaut interne — voyez le terminal.' });
  }
});

const PORT = Number(process.env['PORT'] ?? 4321);

// 127.0.0.1 et non 0.0.0.0 : sur 0.0.0.0, n'importe qui sur le même Wi-Fi
// pourrait émettre des licences en votre nom.
serveur.listen(PORT, '127.0.0.1', () => {
  console.log(`
  Émission des clés d'activation

  Ouvrez :  http://127.0.0.1:${String(PORT)}/?jeton=${JETON}

  Le jeton change à chaque démarrage. Le serveur n'écoute que cette machine,
  et s'arrête avec ce terminal (Ctrl+C).

  Registre : ${CHEMIN_REGISTRE}
`);
});

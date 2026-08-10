# ADR 0007 — Impression ESC/POS

Date : 2026-08-10 · Statut : acceptées (module 6)

## A. La trame est construite en TypeScript, transportée par Rust

`packages/shared/escpos` produit un `Uint8Array` ; la commande Rust `print_raw`
se contente de l'envoyer. Aucune décision de mise en page n'existe côté Rust.

_Pourquoi ce découpage_ : il rend le ticket **testable sans imprimante**, octet
par octet — 24 tests vérifient les commandes, l'encodage et la mise en page. Il
permet aussi de changer de transport (réseau, USB, CUPS) sans toucher à ce qui
est imprimé, et inversement.

La mise en page vient de `renderReceipt`, le même code que l'aperçu à l'écran :
ce que voit le caissier est ce qui sort du rouleau.

## B. Encodage Windows-1252, pas UTF-8

Une imprimante thermique n'est pas en UTF-8 : elle lit une page de codes, un
octet par caractère. Envoyer de l'UTF-8 brut imprime « CafÃ© ».

Windows-1252 (page 16 chez Epson, `ESC t 16`) couvre les accents français, les
guillemets typographiques et le **symbole €**, ce que CP437 ne fait pas.

Deux détails qui ne se voient qu'à l'impression :

- `Intl.NumberFormat` insère une **espace fine insécable** dans « 12 500 € ».
  Non traduite, elle sortirait en « ? ». Elle est convertie en espace ordinaire.
- Un caractère hors table donne « ? » plutôt qu'un échec : un ticket imparfait
  vaut mieux qu'un client qui attend.

## C. L'état est réinitialisé en tête de trame, et rétabli après chaque style

`ESC @` ouvre chaque ticket. Une imprimante conserve l'état laissé par le
précédent : sans remise à zéro, un ticket peut sortir entièrement en gras parce
que le précédent a été interrompu.

De même, `line()` rétablit systématiquement le style par défaut après l'avoir
appliqué — laisser le gras actif contaminerait tout le reste.

## D. Le tiroir s'ouvre en début de trame

L'impulsion `ESC p` précède l'impression : le caissier rend la monnaie pendant
que le papier défile, au lieu d'attendre la fin. Elle n'est envoyée qu'une fois,
même en deux exemplaires, et seulement pour un règlement en espèces.

Le tiroir est branché **sur l'imprimante** : aucun pilote, aucun code
supplémentaire.

## E. Quatre transports, aucune dépendance externe

| Transport | Usage                                         | Vérifié                          |
| --------- | --------------------------------------------- | -------------------------------- |
| `network` | TCP port 9100 — imprimantes Ethernet et Wi-Fi | compile, non essayé sur matériel |
| `cups`    | `lp -d file -o raw` — Linux et macOS          | idem                             |
| `device`  | `/dev/usb/lp0`, `COM3`                        | idem                             |
| `file`    | écrit la trame dans un fichier                | idem                             |

Le transport s'exécute sur un fil séparé (`spawn_blocking`) : une imprimante
hors tension ne doit pas figer la caisse pendant l'expiration du délai.

`-o raw` est indispensable pour CUPS — sans lui, CUPS met la trame en page et
l'imprimante crache des caractères de contrôle.

## F. Ce qui manque, et pourquoi

**Le spouleur Windows n'est pas implémenté.** Une imprimante USB installée avec
son pilote sous Windows s'utilise via `OpenPrinter`/`WritePrinter` (API
winspool), ce qui demande la caisse `windows`. Or je ne peux pas compiler pour
Windows depuis ce poste : `cargo check --target x86_64-pc-windows-gnu` échoue
faute de `mingw-w64`, et le vrai build vise MSVC.

Écrire du code Windows que personne ne peut compiler serait pire que de ne pas
l'écrire. Ce transport sera ajouté au **module 8**, sur Windows, où il pourra
être compilé et essayé. En attendant, une imprimante réseau fonctionne sous
Windows sans rien de plus.

**Rien n'a été essayé sur du matériel réel.** Les trames sont vérifiées octet
par octet, mais aucune imprimante ticket n'était disponible. La cible `file`
des réglages existe pour cela : elle écrit la trame sur disque, ce qui permet de
l'inspecter — et un `cat` sur `/dev/usb/lp0` reste le test ultime.

## G. Réglages propres au poste, jamais synchronisés

L'imprimante est stockée dans la table `meta` locale, hors du moteur de
synchronisation. Deux caisses d'une même boutique ont chacune la leur : les
faire remonter au serveur ferait imprimer l'une sur le rouleau de l'autre.

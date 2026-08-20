# 0028 — L'outil d'émission devient une application, la clé un trousseau

Statut : accepté — 20 août 2026 · remplace [ADR 0026](0026-outil-d-emission.md)

## Contexte

L'ADR 0026 avait donné une interface à l'émission des licences : un serveur
local, une page dans le navigateur, la clé privée en clair dans
`~/.caisse-licence/cle-privee.jwk`. Ça résolvait le confort de saisie et le
registre, et ça supposait une chose que l'éditeur n'a pas acceptée longtemps :
**qu'il n'émette que depuis une seule machine**.

Émettre depuis un autre ordinateur exigeait le dépôt, Node, pnpm et un terminal.
C'est-à-dire, en pratique, impossible en déplacement.

## Décision

Deux changements, indissociables.

### L'outil devient une application de bureau

`apps/licences`, une seconde application Tauri, construite par la même chaîne
que la caisse et publiée pour les mêmes plateformes : `.exe`, `.msi`,
`.AppImage`, `.deb`. Elle s'installe et s'ouvre comme un logiciel ordinaire.

Le serveur local et sa page sont **supprimés**. Deux outils faisant le même
travail auraient écrit dans deux registres différents, et c'est exactement le
morcellement que l'on cherche à éviter. La ligne de commande subsiste, pour les
usages scriptés, mais lit désormais le trousseau.

Cette application n'est **pas** distribuée aux clients et ne reçoit aucun secret
de signature de mise à jour : rien ne doit laisser croire qu'elle leur est
destinée.

### La clé privée devient un trousseau chiffré

Une clé privée perdue **ne se révoque pas**. La clé publique est gravée dans
chaque caisse déjà installée ; qui obtient la privée émet des licences au nom de
l'éditeur jusqu'à ce qu'il republie le logiciel et réémette toutes les licences
en circulation.

Tant que la clé vivait sur une seule machine, un fichier en 0600 suffisait. Dès
qu'elle suit son propriétaire, elle traverse des clés USB qui s'égarent. Elle est
donc scellée par une phrase de passe — PBKDF2-SHA-256, 600 000 itérations, puis
AES-GCM. Un trousseau volé sans sa phrase ne vaut rien.

Douze signes minimum, et non huit : contrairement à un mot de passe de service,
personne ne peut ici limiter les tentatives. L'attaquant a le fichier et tout son
temps.

**Le registre est dans le trousseau.** Émettre depuis deux ordinateurs
scinderait l'historique — chaque machine ne connaîtrait que ses propres ventes,
et l'on perdrait la vue des échéances. Le registre suit donc la clé, dans le même
fichier ; il y est chiffré du même coup, ce qui est souhaitable puisqu'il porte
le nom et le commerce de chaque client.

### Ce qui est fait en TypeScript, et ce qui est fait en Rust

Le Rust lit et écrit un fichier, rien d'autre. Le chiffrement, la signature et la
validation vivent dans `@caisse/shared`, partagés avec la ligne de commande et
les épreuves — les dédoubler en Rust garantirait qu'un jour l'une des deux copies
serait corrigée et pas l'autre.

**Le Rust ne voit jamais la clé privée en clair** : il reçoit et rend du texte
déjà chiffré, et la phrase de passe ne franchit pas la frontière.

L'écriture du fichier est **atomique** — écrire à côté, forcer sur le disque,
renommer. Le trousseau contient l'unique exemplaire de la clé privée : une
coupure au milieu d'une écriture directe laisserait un fichier tronqué,
c'est-à-dire une clé perdue.

### La reprise de l'existant

Une clé en clair laissée par l'ancien outil est **reprise**, pas remplacée.
Engendrer une clé neuve serait le geste le plus dangereux de tout l'outil :
elle n'ouvrirait aucune des caisses déjà installées. L'application propose donc
la reprise quand elle trouve l'ancien fichier, et avertit explicitement lorsqu'il
n'y a rien à reprendre.

L'ancien registre en clair est repris en même temps, ligne par ligne ; une ligne
abîmée n'empêche pas la reprise du reste.

## Conséquences

- L'éditeur émet depuis n'importe quel ordinateur : il installe l'application et
  emporte son trousseau.
- La phrase de passe reste en mémoire tant que la fenêtre est ouverte. Le
  trousseau est rechiffré en entier à chaque émission ; redemander la phrase à
  chaque clé ferait taper une longue phrase dix fois de suite, ce qui pousse à en
  choisir une courte.
- **La phrase de passe ne se récupère pas.** Oubliée, le trousseau et la clé sont
  perdus, et il faut republier le logiciel avec une nouvelle clé publique.
- Le trousseau doit être **sauvegardé**, comme l'était le registre. Il est
  chiffré : une copie dans un dossier synchronisé est acceptable.
- La clé publique de l'éditeur reste celle de `cle-publique.ts`, inchangée : les
  caisses déjà installées continuent d'accepter les clés émises.

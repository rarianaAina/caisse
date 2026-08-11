# Mettre à jour les caisses installées

Une caisse vendue est une caisse qu'on ne peut pas aller voir. Ce document
décrit comment lui envoyer une correction sans se déplacer, et ce qu'il faut
avoir mis en place une fois pour toutes.

## Comment ça marche, vu du commerçant

Dans **Réglages → Mise à jour**, la caisse dit quelle version est installée et
s'il en existe une plus récente. Rien ne se télécharge ni ne s'installe sans un
clic. Trois raisons à cela :

1. l'installation ferme l'application — au milieu d'un service, c'est une file
   d'attente devant un écran noir ;
2. le téléchargement pèse plusieurs dizaines de méga-octets, souvent sur un
   forfait compté ;
3. une mise à jour qui se passe mal doit pouvoir être rejouée au moment choisi.

Une caisse hors ligne n'affiche aucune erreur : c'est son état normal.

## Ce qu'il faut avoir fait UNE fois

### 1. La clé de signature

Chaque mise à jour est signée. L'application vérifie cette signature avant
d'installer quoi que ce soit : sans elle, quiconque intercepte le
téléchargement pourrait remplacer la caisse par autre chose.

La paire de clés a été engendrée et se trouve **hors du dépôt** :

```
/home/kasia/caisse-cle-mise-a-jour.key       ← privée, à garder secrète
/home/kasia/caisse-cle-mise-a-jour.key.pub   ← publique, déjà dans tauri.conf.json
```

**À faire sans tarder :**

1. copier la clé **privée** dans un gestionnaire de mots de passe ou un coffre.
   Elle a été créée **sans mot de passe** : quiconque met la main dessus peut
   signer une fausse mise à jour. Si le poste de développement est partagé,
   en engendrer une nouvelle avec mot de passe :
   `pnpm --filter @caisse/desktop exec tauri signer generate -w chemin.key` ;
2. la déposer dans GitHub → _Settings_ → _Secrets and variables_ → _Actions_ :

   | Secret                               | Valeur                          |
   | ------------------------------------ | ------------------------------- |
   | `TAURI_SIGNING_PRIVATE_KEY`          | le contenu du fichier `.key`    |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | vide, ou le mot de passe choisi |

> ⚠️ **Perdre cette clé privée est irréversible.** Les caisses déjà installées
> n'accepteront plus aucune mise à jour : il faudrait repasser sur chaque poste
> avec un installeur. La clé publique est figée dans les binaires distribués.

### 2. Rien d'autre

Le manifeste `latest.json` est fabriqué par l'intégration continue et joint à
la publication GitHub. Les caisses interrogent
`https://github.com/rarianaAina/caisse/releases/latest/download/latest.json`.

## Publier une version

```bash
# 1. Monter le numéro de version aux DEUX endroits — ils doivent concorder,
#    sinon la caisse se croira à jour ou se mettra à jour en boucle.
#    apps/desktop/package.json          → "version"
#    apps/desktop/src-tauri/tauri.conf.json → "version"

git commit -am "Passe en 0.2.0"
git tag v0.2.0
git push origin main --tags
```

L'intégration continue compile Windows et Linux, signe les paquets, fabrique le
manifeste et crée une publication **en brouillon**.

**Le brouillon est volontaire** : tant qu'il n'est pas publié, aucune caisse ne
voit la mise à jour. C'est la dernière occasion de relire ce qui part chez des
clients. Publier depuis l'interface GitHub déclenche la diffusion.

## Ce que les caisses savent installer

| Format                 | Première installation | Mise à jour |
| ---------------------- | --------------------- | ----------- |
| `.exe` (NSIS, Windows) | oui                   | **oui**     |
| `.msi` (Windows)       | oui                   | non         |
| `.AppImage` (Linux)    | oui                   | **oui**     |
| `.deb` (Linux)         | oui                   | non         |

**Ce qu'il faut livrer aux clients : le `.exe` sous Windows, l'`.AppImage` sous
Linux.** Ce sont les deux seuls formats que l'application sait mettre à jour
elle-même ; un client installé par `.msi` ou `.deb` exigerait un déplacement à
chaque correction.

L'`.AppImage` est un fichier unique, sans installation : le déposer dans
`~/Applications`, le rendre exécutable (`chmod +x`), et créer un raccourci.
Il pèse plus lourd (~79 Mo contre 4 Mo) parce qu'il embarque ses bibliothèques
— c'est précisément ce qui le rend indépendant de la distribution du client.

## L'avertissement Windows, et ce qu'il coûte de le supprimer

Les installeurs ne sont pas signés par un **certificat éditeur**. À la première
installation, Windows affiche un écran bleu SmartScreen : « Windows a protégé
votre ordinateur », et il faut cliquer « Informations complémentaires » puis
« Exécuter quand même ». Les mises à jour suivantes ne le montrent pas — elles
passent par l'application, qui vérifie la signature du projet.

C'est gênant à la vente : un commerçant à qui son ordinateur dit qu'un logiciel
est dangereux se pose des questions légitimes.

Le supprimer demande d'acheter un certificat de signature de code :

|               | Prix indicatif | Effet                                                                                            |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| Certificat OV | ~200–400 €/an  | L'avertissement disparaît **après quelques centaines d'installations** (réputation à construire) |
| Certificat EV | ~350–600 €/an  | L'avertissement disparaît immédiatement ; le certificat vit sur une clé USB ou un HSM            |

Le certificat s'obtient auprès d'un fournisseur (DigiCert, Sectigo, SSL.com…)
et exige de prouver l'existence légale de l'entreprise. **C'est une décision
commerciale, pas technique** : tant qu'elle n'est pas prise, prévenir le client
à l'installation et lui montrer l'écran à l'avance suffit — c'est ce que font
beaucoup de petits éditeurs.

Une fois le certificat obtenu, la configuration se fait dans
`tauri.conf.json` (`bundle.windows.certificateThumbprint`, `signCommand`) et
les secrets correspondants dans l'intégration continue.

## Vérifier qu'une mise à jour marche AVANT de l'envoyer

Sur un poste d'essai, jamais chez un client :

1. installer la version publiée précédente ;
2. publier la nouvelle version (sortie du brouillon) ;
3. dans la caisse d'essai : **Réglages → Mise à jour → Rechercher** ;
4. installer, laisser redémarrer, et **vérifier que les données sont toujours
   là** — c'est ce point qui compte : une mise à jour ne doit jamais toucher à
   la base locale, qui vit dans le dossier de configuration et non à côté de
   l'exécutable.

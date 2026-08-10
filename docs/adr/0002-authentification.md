# ADR 0002 — Authentification, rôles et rattachement des postes

Date : 2026-08-10 · Statut : acceptées (module 2)

## A. Deux algorithmes de hachage, et pourquoi

| Secret                          | Algorithme                                          | Où il est vérifié             |
| ------------------------------- | --------------------------------------------------- | ----------------------------- |
| Mot de passe de connexion       | argon2id (`@node-rs/argon2`)                        | serveur uniquement            |
| Code PIN d'ouverture de session | PBKDF2-HMAC-SHA-256, 210 000 itérations (WebCrypto) | **sur la caisse, hors-ligne** |

Le PIN doit être vérifiable sans réseau, dans la WebView, où aucun module natif
n'existe. PBKDF2 est la seule primitive lente disponible à l'identique dans la
WebView, dans Node et dans les tests — donc la seule qui permette au serveur de
produire une empreinte qu'une caisse déconnectée saura vérifier. Le code vit
dans `packages/shared`, utilisé par les deux côtés.

Un PIN à 4 chiffres a de toute façon une faible entropie : la protection réelle
vient du **blocage après 5 tentatives** (60 s), appliqué localement et par
utilisateur. Le format des empreintes porte son algorithme et son coût
(`pbkdf2-sha256$210000$…`), ce qui permettra de migrer vers argon2 via une
commande Rust sans invalider les PIN existants.

_Écarté_ : le même argon2id des deux côtés (impossible dans la WebView) ; un PIN
vérifié par appel réseau (ferait dépendre l'ouverture de caisse de la connexion,
en contradiction directe avec la contrainte hors-ligne).

## B. Recherche du compte à la connexion : fonction `SECURITY DEFINER`

La RLS filtre sur `app.company_id`, mais à l'ouverture de session l'entreprise
n'est pas encore connue — c'est ce que la recherche doit établir. Une requête
ordinaire sur `app_user` ne renverrait donc jamais rien.

Deux fonctions PostgreSQL `SECURITY DEFINER`, propriété du rôle propriétaire,
contournent la RLS sur ce seul cas d'usage : `auth_lookup_user(email)` et
`auth_email_taken(email)`. Elles ne renvoient que les colonnes nécessaires.

_Écarté_ : une politique RLS permissive sur `app_user` (ouvre toute la table) ;
une seconde connexion privilégiée dans l'API (ce rôle contournerait la RLS pour
**toutes** les requêtes, ce que l'ADR 0001 interdit).

**Corollaire** : l'adresse e-mail devient unique sur toute l'instance, et non
par entreprise, sans quoi la recherche serait ambiguë. Une même personne ne peut
donc pas avoir un compte dans deux entreprises. Si ce cas se présente, il
faudra passer à une sélection explicite de l'entreprise à la connexion. La
suppression logique met `email` à `NULL` pour libérer l'adresse.

## C. Rattachement d'un poste : enrôlement unique, puis autonomie

```
1er lancement (en ligne)     →  connexion + choix de la boutique
                             →  POST /devices/enroll
                             →  recopie locale : entreprise, boutique, caisse,
                                utilisateurs + empreintes de PIN
lancements suivants          →  écran PIN, 100 % hors-ligne
```

L'enrôlement est **idempotent** : réenrôler le même `deviceId` met le poste à
jour au lieu d'en créer un second, donc une réinstallation ne pollue pas la
liste des caisses.

Seuls les utilisateurs **affectés à la boutique du poste** descendent : une
caisse ne détient pas les PIN de toute l'entreprise. Le hash du mot de passe,
lui, ne quitte jamais le serveur.

_Écarté_ : un code d'enrôlement à usage unique généré depuis un back-office
(suppose un back-office web, qui n'existe pas encore) ; un fichier de
configuration pré-provisionné (impraticable pour un commerçant seul).

## D. Rôles : capacités plutôt que rôles en dur

`CAPABILITIES` (dans `@caisse/shared`) associe une action à un rôle minimum.
L'API l'applique via `@RequireCapability('manageCatalog')`, l'interface via
`can(role, 'manageCatalog')`. Un bouton masqué à l'écran correspond donc
exactement à une route refusée par le serveur, et les deux ne peuvent pas
diverger.

Deux garde-fous métier : nul ne peut attribuer un rôle supérieur au sien, et une
entreprise doit conserver au moins un propriétaire actif.

## E. Jetons : accès court, rafraîchissement tournant

Jeton d'accès JWT de 15 minutes, portant l'entreprise (`cid`) — c'est lui qui
alimente `SET LOCAL app.company_id`. Jeton de rafraîchissement de 30 jours,
dont seule l'**empreinte SHA-256** est stockée, et qui est **révoqué à l'instant
où le suivant est émis** : un jeton volé cesse d'être utilisable dès que le
poste légitime se rafraîchit.

Révoquer un poste (`DELETE /devices/:id`) révoque du même coup ses jetons.

**Limite connue** : les jetons sont stockés en clair dans la table `meta` de la
base locale. C'est cohérent avec le reste de la base (catalogue et ventes le
sont aussi) ; le chiffrement au repos se traitera globalement, via SQLCipher, si
le besoin se confirme.

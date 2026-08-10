-- Champs réellement modifiés par chaque écriture.
--
-- Sans cette liste, le serveur ne peut pas répondre à la question dont dépend
-- toute la fusion par champ : « qu'ai-je changé, moi, depuis la version que
-- cette caisse connaissait ? ». La reconstituer en comparant les instantanés
-- successifs de `payload` serait coûteux et approximatif.
ALTER TABLE "change_log" ADD COLUMN "changed_fields" TEXT[] NOT NULL DEFAULT '{}';

-- Préparation 10 km · Christine · Octobre Rose 2026
-- Table de synchronisation du tracker.
--
-- À exécuter dans le dashboard Supabase : SQL Editor → New query → coller → Run.
-- Une ligne par séance (et non un blob JSON) : deux cases cochées en même temps
-- sur deux appareils différents ne s'écrasent jamais.

create table if not exists public.sessions (
  plan_id    text        not null default 'christine-10k',
  session_id text        not null,               -- "3_2" = semaine S3, 3e séance
  done       boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (plan_id, session_id)
);

-- Le tracker lit toujours toutes les séances d'un plan d'un coup.
create index if not exists sessions_plan_idx on public.sessions (plan_id);

-- Horodatage automatique : sert à départager local et distant à la réconciliation
-- (le plus récent gagne), ce qui rend le mode hors-ligne fiable.
-- `set search_path = ''` : sans lui, le linter Supabase signale la fonction
-- (search_path mutable). `now()` vient de pg_catalog, toujours résolu.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sessions_touch on public.sessions;
create trigger sessions_touch
  before update on public.sessions
  for each row execute function public.touch_updated_at();

alter table public.sessions enable row level security;


-- ---------------------------------------------------------------------------
-- POLICIES · exécuter UNE SEULE des deux variantes ci-dessous
-- ---------------------------------------------------------------------------

-- VARIANTE A — sans authentification.
-- Le dépôt est public, donc la clé publishable est visible : n'importe qui la
-- trouvant peut cocher/décocher. Dégât plafonné et réversible, mais table
-- ouverte en écriture. Décommenter pour l'activer.
--
-- create policy "lecture anonyme"  on public.sessions for select using (true);
-- create policy "insertion anonyme" on public.sessions for insert with check (true);
-- create policy "mise à jour anonyme" on public.sessions for update using (true) with check (true);


-- VARIANTE B — authentification par mot de passe, restreinte à deux adresses.
-- (le magic link a été abandonné : SMTP partagé plafonné à 2 mails/heure)
-- Remplacer les adresses ci-dessous par les vôtres avant d'exécuter.
--
-- create policy "lecture autorisée" on public.sessions
--   for select to authenticated
--   using (auth.jwt() ->> 'email' in ('saintseverbenjamin@gmail.com', 'EMAIL_DE_CHRISTINE'));
--
-- create policy "écriture autorisée" on public.sessions
--   for insert to authenticated
--   with check (auth.jwt() ->> 'email' in ('saintseverbenjamin@gmail.com', 'EMAIL_DE_CHRISTINE'));
--
-- create policy "màj autorisée" on public.sessions
--   for update to authenticated
--   using (auth.jwt() ->> 'email' in ('saintseverbenjamin@gmail.com', 'EMAIL_DE_CHRISTINE'))
--   with check (auth.jwt() ->> 'email' in ('saintseverbenjamin@gmail.com', 'EMAIL_DE_CHRISTINE'));


-- ---------------------------------------------------------------------------
-- Synchronisation temps réel entre appareils
-- ---------------------------------------------------------------------------
-- Nécessaire tant que `CONFIG.realtime` est à `true` dans sync.js : sans cette
-- ligne le canal `postgres_changes` se souscrit sans jamais rien recevoir.
-- La RLS continue de filtrer les événements ; la replica identity par défaut
-- (clé primaire) suffit, sync.js ne lit que `payload.new`.
-- Réversible : `alter publication supabase_realtime drop table public.sessions;`
alter publication supabase_realtime add table public.sessions;

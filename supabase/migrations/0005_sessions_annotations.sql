-- Annotations de séance : note libre, distance réalisée, date reportée.
--
-- Jusqu'ici une séance n'était qu'un booléen. Christine doit pouvoir noter
-- une séance, corriger la distance (le prévu et le réalisé diffèrent souvent)
-- et décaler une séance à un autre jour.
--
-- Migration purement additive : les trois colonnes sont nullables, les lignes
-- existantes ne bougent pas, et `null` signifie « conforme au plan ».

alter table public.sessions
  add column if not exists note         text,
  add column if not exists distance_km  numeric(5,2),
  add column if not exists scheduled_on date;

-- Garde-fous : une distance négative ou une note de 10 000 caractères sont
-- des bugs client, pas des saisies. La RLS filtre qui écrit, pas quoi.
alter table public.sessions
  drop constraint if exists sessions_distance_km_check;
alter table public.sessions
  add constraint sessions_distance_km_check
  check (distance_km is null or (distance_km >= 0 and distance_km <= 999));

alter table public.sessions
  drop constraint if exists sessions_note_check;
alter table public.sessions
  add constraint sessions_note_check
  check (note is null or char_length(note) <= 2000);

comment on column public.sessions.note is
  'Note libre saisie par l''athlète. null = pas de note.';
comment on column public.sessions.distance_km is
  'Distance réellement parcourue. null = conforme au plan.';
comment on column public.sessions.scheduled_on is
  'Date de report. null = date déduite du plan (voir plannedDate() côté client).';

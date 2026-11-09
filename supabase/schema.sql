-- Louisiana Document Timeline — Supabase schema
--
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- It is safe to run again; it updates what is already there.
--
-- What it sets up
--   documents          every document, with status 'pending' (submitted, awaiting review) or 'approved'
--   submitter_contacts optional email a submitter leaves; only admins can read it
--   admins             the email addresses allowed to review, approve and edit
--   storage buckets    'submissions' (private: new uploads) and 'public-docs' (public: approved photos)
--
-- Who can do what (enforced by the database, not just the website)
--   anyone             read approved documents; submit a new document (always lands as pending);
--                      upload files into submissions/pending/…
--   admins             everything: read pending submissions and their files, approve, edit, delete

-- ---------------------------------------------------------------------------
-- Admins
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  email text primary key check (email = lower(email))
);
alter table public.admins enable row level security;
-- No policies on purpose: the list is only managed here in the SQL editor.

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'pending' check (status in ('pending', 'approved')),
  title         text not null check (char_length(title) between 1 and 200),
  year          int  check (year between 1500 and 2100),
  month         int  check (month between 1 and 12),
  day           int  check (day between 1 and 31),
  circa         boolean not null default false,
  parish        text not null default '' check (char_length(parish) <= 60),
  type          text not null default 'Other' check (char_length(type) <= 60),
  place         text not null default '' check (char_length(place) <= 300),
  conditions    text[] not null default '{}' check (cardinality(conditions) <= 12),
  people        text not null default '' check (char_length(people) <= 400),
  description   text not null default '' check (char_length(description) <= 4000),
  transcription text not null default '' check (char_length(transcription) <= 40000),
  held_by       text not null default '' check (char_length(held_by) <= 200),
  contributor   text not null default '' check (char_length(contributor) <= 120),
  -- [{ "bucket": "submissions" | "public-docs", "path": "...", "name": "...", "type": "image/jpeg" }]
  files         jsonb not null default '[]'::jsonb
                check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 30),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  approved_at   timestamptz
);
create index if not exists documents_status_idx on public.documents (status);
alter table public.documents enable row level security;

create or replace function public.pending_count()
returns bigint
language sql stable security definer
set search_path = public
as $$ select count(*) from public.documents where status = 'pending' $$;
revoke all on function public.pending_count() from public;
grant execute on function public.pending_count() to anon, authenticated;

-- Anything a website visitor (who isn't an admin) inserts is forced to be a fresh
-- pending submission, and the review queue is capped so spam can't fill the database.
-- Runs as the caller (security invoker) so current_user is the visitor's role;
-- inserts made in the SQL editor are left alone.
create or replace function public.documents_before_write()
returns trigger
language plpgsql security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and current_user in ('anon', 'authenticated') and not public.is_admin() then
    new.status      := 'pending';
    new.approved_at := null;
    new.created_at  := now();
    if public.pending_count() >= 500 then
      raise exception 'The review queue is full right now. Please try again in a few days.';
    end if;
    -- Submitted files must be in the private submissions bucket, under pending/<this document id>/.
    if exists (
      select 1 from jsonb_array_elements(new.files) f
      where f ->> 'bucket' is distinct from 'submissions'
         or (f ->> 'path') not like 'pending/' || new.id::text || '/%'
    ) then
      raise exception 'Invalid file reference.';
    end if;
  end if;
  if new.status = 'approved' and new.approved_at is null then
    new.approved_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists documents_before_write on public.documents;
create trigger documents_before_write
  before insert or update on public.documents
  for each row execute function public.documents_before_write();

drop policy if exists "read approved, admins read all" on public.documents;
create policy "read approved, admins read all" on public.documents
  for select to anon, authenticated
  using (status = 'approved' or public.is_admin());

drop policy if exists "anyone can submit" on public.documents;
create policy "anyone can submit" on public.documents
  for insert to anon, authenticated
  with check (status = 'pending' or public.is_admin());

drop policy if exists "admins update" on public.documents;
create policy "admins update" on public.documents
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete" on public.documents;
create policy "admins delete" on public.documents
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Submitter contact details (never public)
-- ---------------------------------------------------------------------------
create table if not exists public.submitter_contacts (
  document_id uuid primary key references public.documents (id) on delete cascade,
  email       text not null check (char_length(email) between 3 and 254 and email like '%_@_%'),
  created_at  timestamptz not null default now()
);
alter table public.submitter_contacts enable row level security;

drop policy if exists "anyone can leave a contact" on public.submitter_contacts;
create policy "anyone can leave a contact" on public.submitter_contacts
  for insert to anon, authenticated
  with check (true);

drop policy if exists "admins read contacts" on public.submitter_contacts;
create policy "admins read contacts" on public.submitter_contacts
  for select to authenticated
  using (public.is_admin());

drop policy if exists "admins delete contacts" on public.submitter_contacts;
create policy "admins delete contacts" on public.submitter_contacts
  for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('submissions', 'submissions', false, 20971520,
   array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']),
  ('public-docs', 'public-docs', true, 20971520,
   array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "timeline: anyone uploads submissions" on storage.objects;
create policy "timeline: anyone uploads submissions" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'submissions' and (storage.foldername(name))[1] = 'pending');

drop policy if exists "timeline: admins read submissions" on storage.objects;
create policy "timeline: admins read submissions" on storage.objects
  for select to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

drop policy if exists "timeline: admins delete submissions" on storage.objects;
create policy "timeline: admins delete submissions" on storage.objects
  for delete to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

drop policy if exists "timeline: admins manage public docs" on storage.objects;
create policy "timeline: admins manage public docs" on storage.objects
  for all to authenticated
  using (bucket_id = 'public-docs' and public.is_admin())
  with check (bucket_id = 'public-docs' and public.is_admin());

-- ---------------------------------------------------------------------------
-- Make yourself an admin: replace the address below with the email you will
-- sign in with, then run this line (add more lines for more reviewers).
-- ---------------------------------------------------------------------------
-- insert into public.admins (email) values (lower('you@example.com')) on conflict do nothing;
